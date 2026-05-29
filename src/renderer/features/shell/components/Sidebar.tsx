import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { Workspace } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import { useConfigStore } from "../../../state/configStore";
import appIcon from "../../../assets/app-icon-64.png";
import { IconChevronsRight, IconFolder, IconMoreVertical, IconPlus } from "../icons";

interface SidebarProps {
  onToggleCollapse: () => void;
}

function WorkspaceDropIndicator(): JSX.Element {
  return <div className="pointer-events-none mx-1 my-1 h-0.5 rounded-full bg-swath-accent shadow-[0_0_10px_rgba(56,139,253,0.9)]" />;
}

export function Sidebar({ onToggleCollapse }: SidebarProps): JSX.Element {
  const config = useConfigStore((state) => state.config)!;
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const list = useMemo(() => config.workspaces, [config.workspaces]);

  function getDropIndex(clientY: number): number {
    const hoveredIndex = itemRefs.current.findIndex((item) => {
      if (!item) return false;
      const rect = item.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return hoveredIndex === -1 ? list.length : hoveredIndex;
  }

  function finishDrag(): void {
    setDraggedIndex(null);
    setDropIndex(null);
  }

  function moveWorkspace(fromIndex: number | null, insertionIndex = dropIndex ?? list.length): void {
    if (fromIndex !== null && fromIndex !== -1) {
      const toIndex = fromIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
      if (toIndex >= 0 && toIndex < config.workspaces.length && fromIndex !== toIndex) appActions.moveWorkspace(fromIndex, toIndex);
    }
    finishDrag();
  }

  function dropWorkspace(event: DragEvent, insertionIndex = dropIndex ?? list.length): void {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData("text/plain");
    moveWorkspace(draggedId ? config.workspaces.findIndex((workspace) => workspace.id === draggedId) : draggedIndex, insertionIndex);
  }

  useEffect(() => {
    if (draggedIndex === null) return;

    const onMouseMove = (event: MouseEvent): void => {
      event.preventDefault();
      setDropIndex(getDropIndex(event.clientY));
    };
    const onMouseUp = (event: MouseEvent): void => {
      event.preventDefault();
      moveWorkspace(draggedIndex, getDropIndex(event.clientY));
    };

    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp, { once: true });
    return () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [draggedIndex, dropIndex, list.length]);

  const indexOf = (workspace: Workspace): number => config.workspaces.findIndex((item) => item.id === workspace.id);

  return (
    <aside className="z-[2] flex h-full min-h-0 min-w-0 flex-col border-r border-swath-border bg-swath-panel">
      <header className="flex items-center justify-between gap-3 px-3.5 pb-2 pt-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-[30px] place-items-center overflow-visible rounded-none border-0 bg-transparent" aria-hidden>
            <img src={appIcon} alt="" className="size-7 object-contain [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.28))]" />
          </span>
          <div>
            <div className="text-[11px] font-bold uppercase leading-none tracking-[0.12em] text-swath-muted-2">Projects</div>
          </div>
        </div>
      </header>

      <div
        className="flex-1 overflow-y-auto px-2 pb-2.5 pt-1"
        role="list"
        onDragOver={(event) => {
          if (draggedIndex === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropIndex(getDropIndex(event.clientY));
        }}
        onDrop={(event) => dropWorkspace(event)}
      >
        {list.map((workspace, index) => {
          const originalIndex = indexOf(workspace);
          return (
            <div key={workspace.id} className="contents">
              {dropIndex === index ? <WorkspaceDropIndicator /> : null}
              <WorkspaceItem
              itemRef={(element) => {
                itemRefs.current[index] = element;
              }}
              workspace={workspace}
              active={config.activeWorkspaceId === workspace.id}
              originalIndex={originalIndex}
              draggedIndex={draggedIndex}
              onDragStart={() => {
                setDraggedIndex(originalIndex);
                setDropIndex(originalIndex);
              }}
              onDragEnd={finishDrag}
              onMouseDragStart={(event) => {
                event.preventDefault();
                setDraggedIndex(originalIndex);
                setDropIndex(getDropIndex(event.clientY));
              }}
              onDrop={(event) => dropWorkspace(event, getDropIndex(event.clientY))}
              onSelect={() => appActions.selectWorkspace(workspace.id)}
              onRemove={() => void appActions.removeWorkspace(workspace.id)}
              onRename={(name) => appActions.renameWorkspace(workspace.id, name)}
              />
            </div>
          );
        })}
        {dropIndex === list.length ? <WorkspaceDropIndicator /> : null}
      </div>

      <footer className="border-t border-swath-border px-3 pb-3 pt-2.5">
        <div className="flex flex-row items-center gap-2">
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
        </div>
      </footer>
    </aside>
  );
}

interface WorkspaceItemProps {
  itemRef: (element: HTMLDivElement | null) => void;
  workspace: Workspace;
  active: boolean;
  originalIndex: number;
  draggedIndex: number | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMouseDragStart: (event: ReactMouseEvent) => void;
  onDrop: (event: DragEvent) => void;
  onSelect: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
}

function WorkspaceItem({
  itemRef,
  workspace,
  active,
  originalIndex,
  draggedIndex,
  onDragStart,
  onDragEnd,
  onMouseDragStart,
  onDrop,
  onSelect,
  onRemove,
  onRename,
}: WorkspaceItemProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(workspace.name);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const onClick = (): void => {
      setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onClick);
    };
  }, [menuOpen]);

  const activeClasses = active
    ? "border-[rgba(56,139,253,0.35)] bg-[rgba(56,139,253,0.12)] before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[3px] before:rounded-full before:bg-swath-accent before:content-['']"
    : "";

  async function copyWorkingDirectory(): Promise<void> {
    try {
      await navigator.clipboard.writeText(workspace.path);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = workspace.path;
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
      className={`relative my-0.5 flex min-w-0 items-stretch gap-0.5 rounded-md border border-transparent bg-transparent [-webkit-app-region:no-drag] [app-region:no-drag] ${draggedIndex === originalIndex ? "opacity-[0.55]" : ""} ${activeClasses}`}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", workspace.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (draggedIndex === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => onDrop(event)}
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
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-2 pl-1 pr-1.5 text-left [-webkit-app-region:no-drag] [app-region:no-drag]"
        onClick={onSelect}
        title={workspace.path}
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
            <span className="truncate text-[13px] font-bold text-[#eef2f6]">{workspace.name}</span>
          )}
        </span>
      </button>
      <div className="relative flex items-center self-center py-1 pl-1 pr-2 [-webkit-app-region:no-drag] [app-region:no-drag]">
        <button
          type="button"
          className="grid size-8 min-h-8 cursor-pointer place-items-center rounded-lg border border-swath-border bg-swath-bg p-0 text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border-strong hover:bg-[#161b22]"
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((value) => !value);
          }}
          aria-label="Project menu"
        >
          <IconMoreVertical width={17} height={17} className="block" />
        </button>
        {menuOpen ? (
          <div
            className="absolute right-1 top-[34px] z-20 min-w-32 rounded-xl border border-swath-border bg-[#151a22] p-1.5 shadow-swath [-webkit-app-region:no-drag] [app-region:no-drag]"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
              onClick={() => {
                setMenuOpen(false);
                setEditing(true);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
              onClick={() => {
                setMenuOpen(false);
                void copyWorkingDirectory();
              }}
            >
              Copy Working Directory
            </button>
            <button
              type="button"
              className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-swath-danger [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#202735]"
              onClick={() => {
                setMenuOpen(false);
                onRemove();
              }}
            >
              Remove
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
