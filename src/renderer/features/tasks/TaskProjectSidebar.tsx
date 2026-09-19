import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type { Project, Workspace } from "../../../shared/types";
import { useConfigStore } from "../../state/configStore";
import { useTaskStore } from "../../state/taskStore";
import { countPiAgents, usePiActivityStore } from "../tabTypes/piAgent/piActivity";
import { IconChevronDown, IconFolder, IconSparkle } from "../shell/icons";

interface ProjectRow {
  project: Project;
  workspace: Workspace | null;
  group: boolean;
  grouped: boolean;
  memberCount: number;
}

function workspaceForProject(project: Project, workspaces: Workspace[]): Workspace | null {
  return (
    workspaces.find((workspace) => project.id.includes(workspace.id)) ??
    workspaces.find((workspace) => workspace.name === project.name) ??
    null
  );
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

export function TaskProjectSidebar(): JSX.Element {
  const { catalog, local, selectProject, refresh } = useTaskStore();
  const workspaces = useConfigStore((state) => state.config?.workspaces ?? []);
  const activity = usePiActivityStore((state) => state.activity);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const rows = useMemo(() => {
    const mapped = catalog.projects.map((project) => ({
      project,
      workspace: workspaceForProject(project, workspaces),
    }));
    const byWorkspace = new Map(
      mapped.flatMap((row) => (row.workspace ? [[row.workspace.id, row] as const] : [])),
    );
    const ordered: ProjectRow[] = [],
      seen = new Set<string>();
    for (const workspace of workspaces) {
      const row = byWorkspace.get(workspace.id);
      if (!row || seen.has(row.project.id) || workspace.groupId) continue;
      const group = workspace.isGroupRoot === true;
      const members = group
        ? workspaces.flatMap((candidate) =>
            candidate.groupId === workspace.id ? (byWorkspace.get(candidate.id) ?? []) : [],
          )
        : [];
      ordered.push({ ...row, group, grouped: false, memberCount: members.length });
      seen.add(row.project.id);
      if (group && !collapsedGroups.has(workspace.id))
        for (const member of members) {
          ordered.push({ ...member, group: false, grouped: true, memberCount: 0 });
          seen.add(member.project.id);
        }
    }
    for (const row of mapped)
      if (!seen.has(row.project.id))
        ordered.push({ ...row, group: false, grouped: false, memberCount: 0 });
    return ordered;
  }, [catalog.projects, collapsedGroups, workspaces]);

  return (
    <>
      <header className="flex items-center px-3.5 pb-2 pt-2.5">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-swath-muted-2">
          Projects
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-2" role="list">
        {rows.map((row) => {
          const taskIds = new Set(
            catalog.tasks
              .filter((task) => task.projectId === row.project.id)
              .map((task) => task.id),
          );
          const piIds = catalog.panes
            .filter((pane) => taskIds.has(pane.taskId) && pane.kind === "piAgent")
            .map((pane) => pane.id);
          return (
            <ProjectItem
              key={row.project.id}
              {...row}
              active={row.project.id === local.activeProjectId}
              collapsed={Boolean(row.workspace && collapsedGroups.has(row.workspace.id))}
              counts={countPiAgents(activity, piIds)}
              onSelect={() => selectProject(row.project.id)}
              onToggle={() =>
                row.workspace &&
                setCollapsedGroups((current) => {
                  const next = new Set(current);
                  if (next.has(row.workspace!.id)) next.delete(row.workspace!.id);
                  else next.add(row.workspace!.id);
                  return next;
                })
              }
              onRename={async (name) => {
                await window.swath.tasks.rpc({
                  op: "renameProject",
                  projectId: row.project.id,
                  name,
                });
                await refresh();
              }}
              onCopyCwd={async () => {
                let path = row.workspace?.path ?? "";
                if (!path) {
                  const task = catalog.tasks.find((item) => item.projectId === row.project.id);
                  if (task) {
                    const reply = (await window.swath.tasks.rpc({
                      op: "getTask",
                      taskId: task.id,
                    })) as { worktreePath?: string };
                    path = reply.worktreePath ?? "";
                  }
                }
                if (path) await copyText(path);
              }}
              onRemove={async () => {
                if (!window.confirm(`Remove “${row.project.name}” from Swath?`)) return;
                await window.swath.tasks.rpc({ op: "removeProject", projectId: row.project.id });
                await refresh();
              }}
            />
          );
        })}
      </div>
    </>
  );
}

function ProjectItem({
  project,
  group,
  grouped,
  memberCount,
  active,
  collapsed,
  counts,
  onSelect,
  onToggle,
  onRename,
  onCopyCwd,
  onRemove,
}: ProjectRow & {
  active: boolean;
  collapsed: boolean;
  counts: { running: number; done: number };
  onSelect: () => void;
  onToggle: () => void;
  onRename: (name: string) => Promise<void>;
  onCopyCwd: () => Promise<void>;
  onRemove: () => Promise<void>;
}): JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null),
    [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(project.name);
  useEffect(() => setDraft(project.name), [project.name]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null),
      escape = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };
  return (
    <div
      role="listitem"
      onContextMenu={openMenu}
      className={`relative my-0.5 flex min-w-0 items-center rounded-md border ${grouped ? "ml-4 border-l-swath-accent/30" : "border-transparent"} ${active ? "bg-[rgba(56,139,253,0.12)] text-swath-text" : "text-swath-muted hover:bg-swath-bg"}`}
    >
      {group ? (
        <button
          type="button"
          aria-label={collapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className="grid size-7 shrink-0 place-items-center text-swath-muted-2 hover:text-swath-text"
        >
          <IconChevronDown
            width={14}
            height={14}
            className={`transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
      ) : (
        <span className="grid size-7 shrink-0 place-items-center opacity-80" aria-hidden>
          <IconFolder width={15} height={15} />
        </span>
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 bg-transparent py-2 pr-2 text-left"
      >
        {group ? (
          <IconSparkle width={15} height={15} className="shrink-0 text-swath-accent" />
        ) : null}
        {editing ? (
          <input
            autoFocus
            value={draft}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draft.trim() && draft.trim() !== project.name) void onRename(draft.trim());
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraft(project.name);
                setEditing(false);
              }
            }}
            className="min-w-0 flex-1 rounded border border-swath-border bg-swath-bg px-1.5 py-0.5 text-[13px] text-swath-text outline-none focus:border-swath-accent"
          />
        ) : (
          <span className={`min-w-0 flex-1 truncate text-[13px] ${group ? "font-semibold" : ""}`}>
            {project.name}
          </span>
        )}
        {group ? <span className="text-[10px] text-swath-muted-2">{memberCount}</span> : null}
        {counts.running ? (
          <span
            className="size-2 animate-pulse rounded-full bg-swath-good"
            title={`${counts.running} agent running`}
          />
        ) : counts.done ? (
          <span className="text-xs text-swath-good" title={`${counts.done} agent finished`}>
            ✓
          </span>
        ) : null}
      </button>
      {menu ? (
        <div
          className="fixed z-[160] min-w-36 rounded-lg border border-swath-border bg-[#151a22] p-1 shadow-swath-float"
          style={{
            left: Math.min(menu.x, window.innerWidth - 150),
            top: Math.min(menu.y, window.innerHeight - 140),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            className="block w-full rounded px-2.5 py-2 text-left text-xs text-swath-text hover:bg-swath-bg"
            onClick={() => {
              setMenu(null);
              setEditing(true);
            }}
          >
            Rename
          </button>
          <button
            className="block w-full rounded px-2.5 py-2 text-left text-xs text-swath-text hover:bg-swath-bg"
            onClick={() => {
              setMenu(null);
              void onCopyCwd();
            }}
          >
            Copy CWD
          </button>
          <div className="my-1 h-px bg-swath-border" />
          <button
            className="block w-full rounded px-2.5 py-2 text-left text-xs text-swath-danger hover:bg-swath-bg"
            onClick={() => {
              setMenu(null);
              void onRemove();
            }}
          >
            Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}
