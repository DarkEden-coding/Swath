import { useEffect, useMemo, useState } from "react";
import type { Workspace } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import { useConfigStore } from "../../../state/configStore";
import appIcon from "../../../assets/app-icon-64.png";
import { IconChevronsRight, IconFolder, IconMoreVertical, IconPlus } from "../icons";

interface SidebarProps {
  onToggleCollapse: () => void;
}

export function Sidebar({ onToggleCollapse }: SidebarProps): JSX.Element {
  const config = useConfigStore((state) => state.config)!;
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const list = useMemo(() => config.workspaces, [config.workspaces]);

  const indexOf = (workspace: Workspace): number => config.workspaces.findIndex((item) => item.id === workspace.id);

  return (
    <aside className="z-[2] flex h-full min-h-0 min-w-0 flex-col border-r border-swath-border bg-swath-panel">
      <div className="h-9 shrink-0 [-webkit-app-region:drag] [app-region:drag]" />
      <header className="flex items-center justify-between gap-3 px-3.5 pb-2 pt-2.5 [-webkit-app-region:drag] [app-region:drag]">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-[30px] place-items-center overflow-visible rounded-none border-0 bg-transparent" aria-hidden>
            <img src={appIcon} alt="" className="size-7 object-contain [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.28))]" />
          </span>
          <div>
            <div className="text-[11px] font-bold uppercase leading-none tracking-[0.12em] text-swath-muted-2">Projects</div>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-2 pb-2.5 pt-1" role="list">
        {list.map((workspace) => {
          const originalIndex = indexOf(workspace);
          return (
            <WorkspaceItem
              key={workspace.id}
              workspace={workspace}
              active={config.activeWorkspaceId === workspace.id}
              originalIndex={originalIndex}
              draggedIndex={draggedIndex}
              onDragStart={() => setDraggedIndex(originalIndex)}
              onDragEnd={() => setDraggedIndex(null)}
              onDrop={(targetIndex) => {
                if (draggedIndex !== null) appActions.moveWorkspace(draggedIndex, targetIndex);
                setDraggedIndex(null);
              }}
              onSelect={() => appActions.selectWorkspace(workspace.id)}
              onRemove={() => appActions.removeWorkspace(workspace.id)}
              onRename={(name) => appActions.renameWorkspace(workspace.id, name)}
            />
          );
        })}
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
  workspace: Workspace;
  active: boolean;
  originalIndex: number;
  draggedIndex: number | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: (targetIndex: number) => void;
  onSelect: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
}

function WorkspaceItem({
  workspace,
  active,
  originalIndex,
  draggedIndex,
  onDragStart,
  onDragEnd,
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

  return (
    <div
      draggable
      role="listitem"
      className={`relative my-0.5 flex min-w-0 items-stretch gap-0.5 rounded-md border border-transparent bg-transparent ${draggedIndex === originalIndex ? "opacity-[0.55]" : ""} ${activeClasses}`}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(originalIndex);
      }}
    >
      <span
        className="grid w-[22px] shrink-0 cursor-grab grid-cols-[repeat(2,3px)] grid-rows-[repeat(3,3px)] gap-0.5 place-content-center pl-1 opacity-45 [-webkit-app-region:no-drag] [app-region:no-drag]"
        title="Drag to reorder"
        aria-hidden
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
