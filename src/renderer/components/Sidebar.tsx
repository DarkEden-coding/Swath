import { useEffect, useMemo, useState } from "react";
import type { Workspace } from "../../main/sharedTypes";
import { useAppStore } from "../state/appStore";
import appIcon from "../assets/app-icon-64.png";
import {
  IconChevronsRight,
  IconFolder,
  IconMoreVertical,
  IconPlus
} from "./icons";

interface SidebarProps {
  onToggleCollapse: () => void;
}

export function Sidebar({ onToggleCollapse }: SidebarProps): JSX.Element {
  const config = useAppStore((state) => state.config)!;
  const addWorkspaceFromFolder = useAppStore((state) => state.addWorkspaceFromFolder);
  const selectWorkspace = useAppStore((state) => state.selectWorkspace);
  const removeWorkspace = useAppStore((state) => state.removeWorkspace);
  const renameWorkspace = useAppStore((state) => state.renameWorkspace);
  const moveWorkspace = useAppStore((state) => state.moveWorkspace);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const list = useMemo(() => config.workspaces, [config.workspaces]);

  const indexOf = (workspace: Workspace): number => config.workspaces.findIndex((item) => item.id === workspace.id);

  return (
    <aside className="sidebar">
      <div className="traffic-spacer" />
      <header className="sidebar-header">
        <div className="sidebar-brand">
          <span className="sidebar-logo" aria-hidden>
            <img src={appIcon} alt="" />
          </span>
          <div>
            <div className="eyebrow">Projects</div>
          </div>
        </div>
      </header>

      <div className="workspace-list" role="list">
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
                if (draggedIndex !== null) moveWorkspace(draggedIndex, targetIndex);
                setDraggedIndex(null);
              }}
              onSelect={() => selectWorkspace(workspace.id)}
              onRemove={() => removeWorkspace(workspace.id)}
              onRename={(name) => renameWorkspace(workspace.id, name)}
            />
          );
        })}
      </div>

      <footer className="sidebar-footer">
        <div className="sidebar-footer-main">
          <button type="button" className="ghost-icon-btn" title="Collapse sidebar" onClick={onToggleCollapse}>
            <IconChevronsRight width={18} height={18} />
          </button>
          <button type="button" className="add-project-btn" onClick={() => void addWorkspaceFromFolder()}>
            <span className="add-project-plus" aria-hidden>
              <IconPlus width={16} height={16} />
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
  onRename
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

  return (
    <div
      draggable
      role="listitem"
      className={`workspace-item ${active ? "active" : ""} ${draggedIndex === originalIndex ? "dragging" : ""}`}
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
      <span className="workspace-drag" title="Drag to reorder" aria-hidden>
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>
      <button type="button" className="workspace-main" onClick={onSelect} title={workspace.path}>
        <span className="workspace-folder" aria-hidden>
          <IconFolder width={16} height={16} />
        </span>
        <span className="workspace-text">
          {editing ? (
            <input
              className="inline-input"
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
            <span className="workspace-name">{workspace.name}</span>
          )}
        </span>
      </button>
      <div className="workspace-menu-wrap">
        <button type="button" className="row-menu-button" onClick={() => setMenuOpen((value) => !value)} aria-label="Project menu">
          <IconMoreVertical width={17} height={17} />
        </button>
        {menuOpen ? (
          <div className="context-menu">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setEditing(true);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="danger"
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
