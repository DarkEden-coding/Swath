import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Workspace } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import { useConfigStore } from "../../../state/configStore";
import appIcon from "../../../assets/app-icon-64.png";
import { IconChevronDown, IconChevronsRight, IconFolder, IconPlus, IconSparkle } from "../icons";
import { displayWorkspacePath } from "../../../../shared/ipc/remote";
import { useReorderDrag } from "../../../hooks/useReorderDrag";
import {
  groupableTargets,
  isGroupRoot,
  membersOf,
  pairableProjects,
} from "../../../domain/workspaces/groupActions";
import {
  countPiAgents,
  piPaneIdsOfWorkspace,
  usePiActivityStore,
  type PiAgentCounts,
} from "../../tabTypes/piAgent/piActivity";

interface SidebarProps {
  onToggleCollapse: () => void;
}

function WorkspaceDropIndicator(): JSX.Element {
  return (
    <div className="pointer-events-none mx-1 my-1 h-0.5 rounded-full bg-swath-accent shadow-[0_0_10px_rgba(56,139,253,0.9)]" />
  );
}

export function Sidebar({ onToggleCollapse }: SidebarProps): JSX.Element {
  const config = useConfigStore((state) => state.config)!;
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Collapsed groups hide their members, so the sidebar renders a subset of `config.workspaces`.
  // Reordering runs on the visible rows and maps back to configuration indices on drop.
  const rows = useMemo(() => {
    const collapsed = new Set(
      config.workspaces
        .filter((workspace) => isGroupRoot(workspace) && workspace.groupCollapsed === true)
        .map((workspace) => workspace.id),
    );
    return config.workspaces
      .map((workspace, index) => ({ workspace, index }))
      .filter(
        ({ workspace }) => workspace.groupId === undefined || !collapsed.has(workspace.groupId),
      );
  }, [config.workspaces]);

  const reorder = useReorderDrag({
    axis: "vertical",
    itemCount: rows.length,
    getElements: () => itemRefs.current.filter((item): item is HTMLDivElement => item !== null),
    findIndexById: (id) => rows.findIndex(({ workspace }) => workspace.id === id),
    onMove: (fromIndex, toIndex) => {
      const from = rows[fromIndex]?.index;
      const to = rows[toIndex]?.index;
      if (from !== undefined && to !== undefined) appActions.moveWorkspace(from, to);
    },
  });
  const { draggedId, dropIndex, finishDrag } = reorder;
  const draggedIndex =
    draggedId === null ? null : rows.findIndex(({ workspace }) => workspace.id === draggedId);

  const activeGroupId = useMemo(() => {
    const active = config.workspaces.find((workspace) => workspace.id === config.activeWorkspaceId);
    if (!active) return null;
    return isGroupRoot(active) ? active.id : (active.groupId ?? null);
  }, [config.workspaces, config.activeWorkspaceId]);

  const agentActivity = usePiActivityStore((state) => state.activity);
  const acknowledgePanes = usePiActivityStore((state) => state.acknowledgePanes);

  return (
    <aside className="z-[2] flex h-full min-h-0 min-w-0 flex-col border-r border-swath-border bg-swath-panel">
      <header className="flex items-center justify-between gap-3 px-3.5 pb-2 pt-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="grid size-[30px] place-items-center overflow-visible rounded-none border-0 bg-transparent"
            aria-hidden
          >
            <img
              src={appIcon}
              alt=""
              className="size-7 object-contain [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.28))]"
            />
          </span>
          <div>
            <div className="text-[11px] font-bold uppercase leading-none tracking-[0.12em] text-swath-muted-2">
              Projects
            </div>
          </div>
        </div>
      </header>

      <div
        className="flex-1 overflow-y-auto px-2 pb-2.5 pt-1"
        role="list"
        onDragOver={(event) => {
          reorder.handleNativeDragOver(event);
        }}
        onDrop={reorder.handleNativeDrop}
      >
        {rows.map(({ workspace }, rowIndex) => {
          const group = isGroupRoot(workspace);
          const members = group ? membersOf(config, workspace.id) : [];
          const inActiveGroup =
            activeGroupId !== null &&
            (workspace.groupId === activeGroupId || workspace.id === activeGroupId);
          const shared = {
            itemRef: (element: HTMLDivElement | null) => {
              itemRefs.current[rowIndex] = element;
            },
            workspace,
            active: config.activeWorkspaceId === workspace.id,
            missing: workspace.isMissing === true,
            rowIndex,
            draggedIndex,
            onDragStart: (event: DragEvent) =>
              reorder.startNativeDrag(event, workspace.id, rowIndex),
            onDragEnd: finishDrag,
            onMouseDragStart: (event: ReactMouseEvent) =>
              reorder.startPointerDrag(event, workspace.id),
            onDrop: reorder.handleNativeDrop,
            // Selecting a project clears its finished-but-unseen marker; running agents keep the
            // spinner until they finish a later run.
            onSelect: () => {
              acknowledgePanes(piPaneIdsOfWorkspace(workspace));
              appActions.selectWorkspace(workspace.id);
            },
            onRemove: () => void appActions.removeWorkspace(workspace.id),
            onRename: (name: string) => appActions.renameWorkspace(workspace.id, name),
          };
          return (
            <div key={workspace.id} className="contents">
              {dropIndex === rowIndex ? <WorkspaceDropIndicator /> : null}
              {group ? (
                <GroupHeaderItem
                  {...shared}
                  memberCount={members.length}
                  agentCounts={countPiAgents(agentActivity, piPaneIdsOfWorkspace(workspace))}
                  collapsed={workspace.groupCollapsed === true}
                  onToggleCollapsed={() =>
                    appActions.setGroupCollapsed(workspace.id, workspace.groupCollapsed !== true)
                  }
                />
              ) : (
                <GroupRail grouped={workspace.groupId !== undefined} lit={inActiveGroup}>
                  <WorkspaceItem
                    {...shared}
                    grouped={workspace.groupId !== undefined}
                    agentCounts={countPiAgents(agentActivity, piPaneIdsOfWorkspace(workspace))}
                    groupTargets={groupableTargets(config, workspace.id)}
                    pairTargets={pairableProjects(config, workspace.id)}
                  />
                </GroupRail>
              )}
            </div>
          );
        })}
        {dropIndex === rows.length ? <WorkspaceDropIndicator /> : null}
      </div>

      <footer className="border-t border-swath-border px-3 pb-3 pt-2.5">
        <div className="grid grid-cols-[34px_1fr] items-center gap-2">
          <button
            type="button"
            className="grid size-[34px] shrink-0 cursor-pointer place-items-center rounded-lg border border-transparent bg-transparent text-base text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border hover:bg-swath-bg hover:text-swath-text"
            title="Collapse sidebar"
            onClick={onToggleCollapse}
          >
            <IconChevronsRight width={18} height={18} className="block" />
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border border-swath-accent bg-transparent px-2.5 py-2 text-[13px] font-semibold text-swath-accent-strong [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[rgba(56,139,253,0.08)]"
            onClick={() => void appActions.addWorkspaceFromFolder()}
          >
            <span className="block text-base leading-none" aria-hidden>
              <IconPlus width={16} height={16} className="block" />
            </span>
            Add Project
          </button>
          <span />
          <button
            type="button"
            className="flex min-w-0 items-center justify-center gap-2 rounded-md border border-swath-border bg-swath-bg px-2.5 py-2 text-[12px] font-semibold text-swath-muted hover:border-swath-accent hover:text-swath-accent-strong"
            onClick={appActions.openRemoteConnect}
          >
            <span className="text-swath-accent" aria-hidden>
              ⇄
            </span>{" "}
            Connect to Remote
          </button>
        </div>
      </footer>
    </aside>
  );
}

interface WorkspaceItemProps {
  itemRef: (element: HTMLDivElement | null) => void;
  workspace: Workspace;
  active: boolean;
  missing: boolean;
  rowIndex: number;
  draggedIndex: number | null;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onMouseDragStart: (event: ReactMouseEvent) => void;
  onDrop: (event: DragEvent) => void;
  onSelect: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
  /** Live agent counts for this row's spinner indicator. */
  agentCounts: PiAgentCounts;
}

interface ProjectItemProps extends WorkspaceItemProps {
  /** True when the project already belongs to a group. */
  grouped: boolean;
  /** Existing groups this project could join. */
  groupTargets: Workspace[];
  /** Loose projects this one could pair up with into a new group. */
  pairTargets: Workspace[];
}

function WorkspaceItem({
  itemRef,
  workspace,
  active,
  missing,
  rowIndex,
  draggedIndex,
  onDragStart,
  onDragEnd,
  onMouseDragStart,
  onDrop,
  onSelect,
  onRemove,
  onRename,
  agentCounts,
  grouped,
  groupTargets,
  pairTargets,
}: ProjectItemProps): JSX.Element {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(workspace.name);

  useEffect(() => {
    if (!menuPosition) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuPosition(null);
    };
    const onClick = (): void => {
      setMenuPosition(null);
      setSubmenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onClick);
    };
  }, [menuPosition]);

  const activeClasses = active
    ? "border-[rgba(56,139,253,0.35)] bg-[rgba(56,139,253,0.12)] before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[3px] before:rounded-full before:bg-swath-accent before:content-['']"
    : "";

  async function copyWorkingDirectory(): Promise<void> {
    try {
      await navigator.clipboard.writeText(displayWorkspacePath(workspace.path));
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = displayWorkspacePath(workspace.path);
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  }

  return (
    <div
      ref={itemRef}
      draggable={false}
      role="listitem"
      className={`relative my-0.5 flex min-w-0 items-stretch gap-0.5 rounded-md border border-transparent bg-transparent [-webkit-app-region:no-drag] [app-region:no-drag] ${draggedIndex === rowIndex ? "opacity-[0.55]" : ""} ${missing ? "grayscale opacity-45" : ""} ${activeClasses}`}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", workspace.id);
        onDragStart(event);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (draggedIndex === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => onDrop(event)}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      <span
        className="grid w-[22px] shrink-0 cursor-grab grid-cols-[repeat(2,3px)] grid-rows-[repeat(3,3px)] gap-0.5 place-content-center pl-1 opacity-45 [-webkit-app-region:no-drag] [app-region:no-drag]"
        title="Drag to reorder"
        aria-hidden
        onMouseDown={onMouseDragStart}
      >
        <span className="size-[3px] rounded-full bg-swath-muted-2" />
        <span className="size-[3px] rounded-full bg-swath-muted-2" />
        <span className="size-[3px] rounded-full bg-swath-muted-2" />
        <span className="size-[3px] rounded-full bg-swath-muted-2" />
        <span className="size-[3px] rounded-full bg-swath-muted-2" />
        <span className="size-[3px] rounded-full bg-swath-muted-2" />
      </span>
      <button
        type="button"
        className={`flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent py-2 pl-1 pr-1.5 text-left [-webkit-app-region:no-drag] [app-region:no-drag] ${missing ? "cursor-not-allowed" : "cursor-pointer"}`}
        aria-disabled={missing}
        onClick={() => {
          if (!missing) onSelect();
        }}
        title={
          missing
            ? `${displayWorkspacePath(workspace.path)} (folder unavailable)`
            : displayWorkspacePath(workspace.path)
        }
      >
        <span className="shrink-0 text-sm opacity-85" aria-hidden>
          <IconFolder width={16} height={16} className="block" />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          {editing ? (
            <input
              className="h-[26px] w-[170px] rounded-lg border border-swath-border bg-swath-bg px-[7px] py-0.5 text-swath-text outline-none [-webkit-app-region:no-drag] [app-region:no-drag] focus:border-swath-accent focus:shadow-[0_0_0_2px_rgba(56,139,253,0.15)]"
              value={draftName}
              autoFocus
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={() => {
                setEditing(false);
                onRename(draftName);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setDraftName(workspace.name);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-[#eef2f6]">
              {workspace.name}
            </span>
          )}
        </span>
        {workspace.remoteConnectionId ? (
          <RemoteProjectIndicator connectionId={workspace.remoteConnectionId} />
        ) : null}
        <AgentActivityIndicator counts={agentCounts} />
      </button>
      {menuPosition ? (
        <div
          className="fixed z-20 min-w-32 rounded-xl border border-swath-border bg-[#151a22] p-1.5 shadow-swath [-webkit-app-region:no-drag] [app-region:no-drag]"
          style={{
            left: Math.max(4, Math.min(menuPosition.x, window.innerWidth - 140)),
            top: Math.max(4, Math.min(menuPosition.y, window.innerHeight - 132)),
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
            onClick={() => {
              setMenuPosition(null);
              setEditing(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
            onClick={() => {
              setMenuPosition(null);
              void copyWorkingDirectory();
            }}
          >
            CWD
          </button>
          <div className="my-1 h-px bg-swath-border" />
          {grouped ? (
            <button
              type="button"
              className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
              onClick={() => {
                setMenuPosition(null);
                appActions.ungroupWorkspace(workspace.id);
              }}
            >
              Remove from group
            </button>
          ) : (
            <button
              type="button"
              className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735] flex items-center justify-between gap-3"
              disabled={groupTargets.length === 0 && pairTargets.length === 0}
              onClick={(event) => {
                event.stopPropagation();
                setSubmenuOpen((open) => !open);
              }}
            >
              <span
                className={
                  groupTargets.length === 0 && pairTargets.length === 0 ? "text-swath-muted-2" : ""
                }
              >
                Group with
              </span>
              <span aria-hidden className="text-swath-muted-2">
                ›
              </span>
            </button>
          )}
          {submenuOpen ? (
            <div className="mt-0.5 max-h-64 overflow-y-auto rounded-lg border border-swath-border bg-[#111720] p-1">
              {groupTargets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735] truncate text-[12px]"
                  onClick={() => {
                    setMenuPosition(null);
                    appActions.addWorkspaceToGroup(workspace.id, target.id);
                  }}
                >
                  {target.name}
                </button>
              ))}
              {pairTargets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735] truncate text-[12px]"
                  onClick={() => {
                    setMenuPosition(null);
                    appActions.createGroupWith(workspace.id, target.id);
                  }}
                >
                  {target.name}
                  <span className="ml-1 text-swath-muted-2">— new group</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="my-1 h-px bg-swath-border" />
          <button
            type="button"
            className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-danger [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
            onClick={() => {
              setMenuPosition(null);
              onRemove();
            }}
          >
            Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RemoteProjectIndicator({ connectionId }: { connectionId: string }): JSX.Element {
  const [status, setStatus] = useState(() => window.swath.remote.status(connectionId));
  useEffect(
    () =>
      window.swath.remote.onStatus((id, next) => {
        if (id === connectionId) setStatus(next);
      }),
    [connectionId],
  );
  const color =
    status === "connected"
      ? "bg-swath-good"
      : status === "connecting"
        ? "bg-swath-warning"
        : "bg-swath-danger";
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full border border-swath-border bg-swath-bg px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-swath-muted"
      title={`Remote device: ${status}`}
    >
      <span className={`size-1.5 rounded-full ${color}`} aria-hidden /> remote
    </span>
  );
}

/** Ties a group's members together with a rail that lights up while the group is in use. */
function GroupRail({
  grouped,
  lit,
  children,
}: {
  grouped: boolean;
  lit: boolean;
  children: React.ReactNode;
}): JSX.Element {
  if (!grouped) return <>{children}</>;
  return (
    <div className="flex min-w-0 items-stretch">
      <span
        aria-hidden
        className={`my-0.5 ml-2.5 w-px shrink-0 rounded-full ${lit ? "bg-swath-accent/70" : "bg-swath-border"}`}
      />
      <div className="min-w-0 flex-1 pl-1.5">{children}</div>
    </div>
  );
}

/** Ring size constants for the sidebar agent spinner (r = 7.25 on an 18px viewBox). */
const SIDEBAR_RING_RADIUS = 7.25;
const SIDEBAR_RING_CIRCUMFERENCE = 2 * Math.PI * SIDEBAR_RING_RADIUS;

/**
 * A project or group row's agent spinner: grey ring with the running count inside, turning green
 * proportionally as agents finish. Selecting the row acknowledges the finished ones, leaving only
 * the grey remainder — or nothing at all when every agent is done.
 */
function AgentActivityIndicator({ counts }: { counts: PiAgentCounts }): JSX.Element | null {
  const total = counts.running + counts.done;
  if (total === 0) return null;
  const spinning = counts.running > 0;
  const title = spinning
    ? `${counts.running} agent${counts.running === 1 ? "" : "s"} running`
    : `${counts.done} agent${counts.done === 1 ? "" : "s"} finished`;
  return (
    <span
      className={`relative ml-auto grid size-[18px] shrink-0 place-items-center ${spinning ? "animate-spin" : ""}`}
      title={title}
      aria-hidden
    >
      <svg viewBox="0 0 18 18" className="absolute inset-0 size-[18px]" fill="none">
        <circle
          cx="9"
          cy="9"
          r={SIDEBAR_RING_RADIUS}
          className="stroke-swath-border"
          strokeWidth="2"
        />
        {counts.done > 0 ? (
          <circle
            cx="9"
            cy="9"
            r={SIDEBAR_RING_RADIUS}
            className="stroke-swath-good"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${
              (counts.done / total) * SIDEBAR_RING_CIRCUMFERENCE
            } ${SIDEBAR_RING_CIRCUMFERENCE}`}
            transform="rotate(-90 9 9)"
          />
        ) : null}
      </svg>
      <span
        className={`relative text-[9px] font-bold leading-none ${spinning ? "text-swath-muted" : "text-swath-good"}`}
      >
        {spinning ? counts.running : counts.done}
      </span>
    </span>
  );
}

interface GroupHeaderItemProps extends WorkspaceItemProps {
  memberCount: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * A group's row: it selects the group's shared agents surface, which is a workspace of its own.
 */
function GroupHeaderItem({
  itemRef,
  workspace,
  active,
  missing,
  rowIndex,
  draggedIndex,
  onDragStart,
  onDragEnd,
  onMouseDragStart,
  onDrop,
  onSelect,
  onRemove,
  onRename,
  agentCounts,
  memberCount,
  collapsed,
  onToggleCollapsed,
}: GroupHeaderItemProps): JSX.Element {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(workspace.name);

  useEffect(() => {
    if (!menuPosition) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuPosition(null);
    };
    const onClick = (): void => {
      setMenuPosition(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onClick);
    };
  }, [menuPosition]);

  const activeClasses = active
    ? "border-[rgba(56,139,253,0.35)] bg-[rgba(56,139,253,0.12)] before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[3px] before:rounded-full before:bg-swath-accent before:content-['']"
    : "";

  return (
    <div
      ref={itemRef}
      draggable={false}
      role="listitem"
      className={`relative my-0.5 flex min-w-0 items-stretch gap-0.5 rounded-md border border-transparent bg-transparent [-webkit-app-region:no-drag] [app-region:no-drag] ${draggedIndex === rowIndex ? "opacity-[0.55]" : ""} ${missing ? "grayscale opacity-45" : ""} ${activeClasses}`}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", workspace.id);
        onDragStart(event);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (draggedIndex === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => onDrop(event)}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
      onMouseDown={onMouseDragStart}
    >
      <button
        type="button"
        className="grid w-[22px] shrink-0 cursor-pointer place-items-center border-0 bg-transparent p-0 text-swath-muted-2 [-webkit-app-region:no-drag] [app-region:no-drag] hover:text-swath-text"
        title={collapsed ? "Show projects" : "Hide projects"}
        aria-expanded={!collapsed}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onToggleCollapsed();
        }}
      >
        <IconChevronDown
          width={14}
          height={14}
          className={`block transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-2 pl-0.5 pr-1.5 text-left [-webkit-app-region:no-drag] [app-region:no-drag]"
        onClick={onSelect}
        title={`${workspace.name} — shared agents across ${memberCount} folders`}
      >
        <span className="shrink-0 text-swath-accent" aria-hidden>
          <IconSparkle width={15} height={15} className="block" />
        </span>
        {editing ? (
          <input
            className="h-[26px] w-[170px] rounded-lg border border-swath-border bg-swath-bg px-[7px] py-0.5 text-swath-text outline-none [-webkit-app-region:no-drag] [app-region:no-drag] focus:border-swath-accent focus:shadow-[0_0_0_2px_rgba(56,139,253,0.15)]"
            value={draftName}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => {
              setEditing(false);
              onRename(draftName);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraftName(workspace.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-[0.08em] text-[#eef2f6]">
            {workspace.name}
          </span>
        )}
        <AgentActivityIndicator counts={agentCounts} />
        <span className="shrink-0 rounded-full border border-swath-border px-1.5 text-[10px] font-semibold text-swath-muted-2">
          {memberCount}
        </span>
      </button>
      {menuPosition ? (
        <div
          className="fixed z-20 min-w-32 rounded-xl border border-swath-border bg-[#151a22] p-1.5 shadow-swath [-webkit-app-region:no-drag] [app-region:no-drag]"
          style={{
            left: Math.max(4, Math.min(menuPosition.x, window.innerWidth - 140)),
            top: Math.max(4, Math.min(menuPosition.y, window.innerHeight - 132)),
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
            onClick={() => {
              setMenuPosition(null);
              setEditing(true);
            }}
          >
            Rename group
          </button>
          <button
            type="button"
            className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
            onClick={() => {
              setMenuPosition(null);
              onToggleCollapsed();
            }}
          >
            {collapsed ? "Show projects" : "Hide projects"}
          </button>
          <div className="my-1 h-px bg-swath-border" />
          <button
            type="button"
            className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-danger [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
            onClick={() => {
              setMenuPosition(null);
              onRemove();
            }}
          >
            Break up group
          </button>
        </div>
      ) : null}
    </div>
  );
}
