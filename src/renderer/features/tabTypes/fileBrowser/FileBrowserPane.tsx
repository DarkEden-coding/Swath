import { useCallback, useEffect, useState, type DragEvent } from "react";
import type { FilesEntry } from "../../../../shared/ipc";
import * as appActions from "../../../app/appActions";
import { findPane } from "../../../domain/layout/layoutTree";
import { dialogClient } from "../../../services/dialogClient";
import { filesClient } from "../../../services/filesClient";
import { useUiStore } from "../../../state/uiStore";
import { PaneFrame } from "../../panes/components/PaneFrame";
import type { PaneComponentProps } from "../../panes/paneTypes";
import {
  IconChevronDown,
  IconChevronsRight,
  IconFolder,
  IconPencil,
  IconRefresh,
  IconTrash,
} from "../../shell/icons";
import {
  baseName,
  canDropInto,
  isImagePath,
  isValidName,
  joinPath,
  parentPath,
} from "./fileBrowserUtils";

const ROOT = "";

type DirEntries = Record<string, FilesEntry[]>;

/**
 * Workspace-rooted file tree with rename, drag-to-move, and trash. All paths are
 * relative to the pane cwd and containment is enforced host-side.
 */
export function FileBrowserPane({ workspace, view, pane }: PaneComponentProps): JSX.Element {
  const activePaneId = useUiStore((state) => state.activePaneId);
  const paneId = pane.id;
  const paneMeta = findPane(view.layout, paneId);
  const cwd = (paneMeta?.cwd ?? workspace.path).trim() || workspace.path.trim();
  const headerTitle = paneMeta?.title ?? paneMeta?.metadata?.title ?? "Files";
  const isActive = activePaneId === paneId || view.activePaneId === paneId;

  const [entries, setEntries] = useState<DirEntries>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]));
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Reloads the given directories, dropping any that no longer resolve. */
  const loadDirs = useCallback(
    async (dirs: string[]): Promise<void> => {
      if (!cwd) return;
      const results = await Promise.all(
        dirs.map(async (dir) => {
          try {
            return [dir, await filesClient.list(cwd, dir)] as const;
          } catch (loadError) {
            if (dir === ROOT) throw loadError;
            return [dir, null] as const;
          }
        }),
      );
      setEntries((prev) => {
        const next = { ...prev };
        for (const [dir, list] of results) {
          if (list) next[dir] = list;
          else delete next[dir];
        }
        return next;
      });
    },
    [cwd],
  );

  /** Reloads every directory currently visible in the tree. */
  const reload = async (dirs: string[]): Promise<void> => {
    try {
      await loadDirs(dirs);
      setError(null);
    } catch (reloadError) {
      setError(reloadError instanceof Error ? reloadError.message : String(reloadError));
    }
  };

  useEffect(() => {
    void loadDirs([ROOT]).catch(() => setError("Unable to read workspace folder"));
  }, [loadDirs]);

  const toggleDir = (path: string): void => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
    if (next.has(path)) void reload([path]);
  };

  /** Runs a mutation, then refreshes the visible directories it touched. */
  const mutate = async (action: () => Promise<void>, dirs: string[]): Promise<void> => {
    setBusy(true);
    try {
      await action();
      setError(null);
      await reload([...new Set(dirs)].filter((dir) => dir === ROOT || expanded.has(dir)));
    } catch (mutateError) {
      setError(mutateError instanceof Error ? mutateError.message : String(mutateError));
    } finally {
      setBusy(false);
    }
  };

  const commitRename = async (): Promise<void> => {
    if (!renaming) return;
    const { path, value } = renaming;
    setRenaming(null);
    const name = value.trim();
    if (!isValidName(name) || name === baseName(path)) return;
    const dir = parentPath(path);
    await mutate(() => filesClient.rename(cwd, path, joinPath(dir, name)), [dir]);
  };

  const moveEntry = async (source: string, targetDir: string): Promise<void> => {
    await mutate(
      () => filesClient.rename(cwd, source, joinPath(targetDir, baseName(source))),
      [parentPath(source), targetDir],
    );
  };

  const deleteEntry = async (path: string): Promise<void> => {
    const confirmed = await dialogClient.confirm({
      message: `Move "${baseName(path)}" to the trash?`,
      detail: path,
      confirmLabel: "Move to Trash",
    });
    if (!confirmed) return;
    await mutate(() => filesClient.trash(cwd, path), [parentPath(path)]);
  };

  const openEntry = (entry: FilesEntry): void => {
    if (entry.isDir) {
      toggleDir(entry.path);
      return;
    }
    if (!isImagePath(entry.path)) return;
    appActions.upsertImagePreviewFromPane(workspace.id, view.id, paneId, entry.path, entry.name);
  };

  const dropHandlers = (
    targetDir: string,
  ): Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop"> => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragPath || !canDropInto(dragPath, targetDir)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropDir(targetDir);
    },
    onDragLeave: () => setDropDir((current) => (current === targetDir ? null : current)),
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const source = dragPath;
      setDropDir(null);
      setDragPath(null);
      if (source && canDropInto(source, targetDir)) void moveEntry(source, targetDir);
    },
  });

  const iconBtn =
    "grid size-6 shrink-0 place-items-center rounded border border-transparent text-swath-muted opacity-0 group-hover:opacity-100 hover:border-swath-border hover:bg-swath-panel-2 hover:text-swath-text disabled:opacity-40";

  const renderRows = (dir: string, depth: number): JSX.Element[] =>
    (entries[dir] ?? []).flatMap((entry) => {
      const isOpen = entry.isDir && expanded.has(entry.path);
      const isDropTarget = entry.isDir && dropDir === entry.path;
      const row = (
        <div
          key={entry.path}
          className={`group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[13px] ${
            selected === entry.path ? "bg-swath-panel-2 text-swath-text" : "text-swath-text"
          } ${isDropTarget ? "outline outline-1 outline-swath-accent" : ""} ${
            dragPath === entry.path ? "opacity-50" : ""
          } hover:bg-swath-panel-2`}
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          draggable={!renaming}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", entry.path);
            setDragPath(entry.path);
          }}
          onDragEnd={() => {
            setDragPath(null);
            setDropDir(null);
          }}
          {...(entry.isDir ? dropHandlers(entry.path) : {})}
          onClick={() => setSelected(entry.path)}
          onDoubleClick={() => openEntry(entry)}
        >
          {entry.isDir ? (
            <button
              type="button"
              className="grid size-4 shrink-0 place-items-center border-0 bg-transparent p-0 text-swath-muted"
              tabIndex={-1}
              title={isOpen ? "Collapse" : "Expand"}
              onClick={(event) => {
                event.stopPropagation();
                toggleDir(entry.path);
              }}
            >
              {isOpen ? (
                <IconChevronDown width={14} height={14} className="block" />
              ) : (
                <IconChevronsRight width={14} height={14} className="block" />
              )}
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          {entry.isDir ? (
            <IconFolder width={14} height={14} className="block shrink-0 text-swath-accent" />
          ) : null}
          {renaming?.path === entry.path ? (
            <input
              className="min-w-0 flex-1 rounded border border-swath-border bg-swath-bg px-1 py-0.5 text-[13px] text-swath-text outline-none focus:border-swath-accent"
              value={renaming.value}
              autoFocus
              onChange={(event) => setRenaming({ path: entry.path, value: event.target.value })}
              onClick={(event) => event.stopPropagation()}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitRename();
                if (event.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          )}
          <button
            type="button"
            className={iconBtn}
            title="Rename"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              setRenaming({ path: entry.path, value: entry.name });
            }}
          >
            <IconPencil width={13} height={13} className="block" />
          </button>
          <button
            type="button"
            className={iconBtn}
            title="Move to trash"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void deleteEntry(entry.path);
            }}
          >
            <IconTrash width={13} height={13} className="block" />
          </button>
        </div>
      );
      return isOpen ? [row, ...renderRows(entry.path, depth + 1)] : [row];
    });

  return (
    <PaneFrame
      active={isActive}
      title={headerTitle}
      statusClass={busy ? "running" : "dormant"}
      onActivate={() => appActions.setActivePane(workspace.id, view.id, paneId)}
      onSplitRight={(kind) => appActions.splitPane(workspace.id, view.id, paneId, "vertical", kind)}
      onSplitDown={(kind) =>
        appActions.splitPane(workspace.id, view.id, paneId, "horizontal", kind)
      }
      onClose={() => appActions.closePane(workspace.id, view.id, paneId)}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-swath-bg text-[13px] text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag]">
        <div
          className={`flex shrink-0 items-center justify-between gap-2 border-b border-swath-border px-2.5 py-2 ${
            dropDir === ROOT ? "bg-swath-panel-2" : ""
          }`}
          {...dropHandlers(ROOT)}
        >
          <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-swath-muted">
            {cwd || "No workspace folder"}
          </span>
          <button
            type="button"
            className="grid size-8 shrink-0 place-items-center rounded-md border border-transparent text-swath-muted hover:border-swath-border hover:bg-swath-panel-2 hover:text-swath-text disabled:opacity-40"
            title="Refresh"
            disabled={busy || !cwd}
            onClick={() => void reload([...expanded])}
          >
            <IconRefresh width={16} height={16} className="block" />
          </button>
        </div>
        {error ? (
          <div className="shrink-0 border-b border-swath-border px-2.5 py-1.5 text-[12px] text-swath-warn">
            {error}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto py-1" {...dropHandlers(ROOT)}>
          {(entries[ROOT] ?? []).length === 0 && !error ? (
            <div className="px-3 py-2 text-[12px] text-swath-muted">This folder is empty.</div>
          ) : (
            renderRows(ROOT, 0)
          )}
        </div>
      </div>
    </PaneFrame>
  );
}
