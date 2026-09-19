import type {
  DeviceId,
  PaneId,
  Project,
  ProjectId,
  Task,
  TaskId,
  TaskPane,
} from "../../../shared/types";

/** Shared state replicated by the catalog. Layout and selection intentionally do not live here. */
export interface TaskCatalog {
  projects: Project[];
  tasks: Task[];
  panes: TaskPane[];
}

/** Per-interface state: this must never be sent to another device. */
export interface TaskInterfaceState {
  activeProjectId: ProjectId | null;
  activeTaskId: TaskId | null;
  focusedPaneId: PaneId | null;
  /** Shared pane IDs in the locally visible order. Split geometry stays in the existing layout. */
  paneOrderByTask: Record<TaskId, PaneId[]>;
  hiddenPaneIds: PaneId[];
  /** Unsent composer text stays on this interface only. */
  drafts?: Record<PaneId, string>;
  historicalTaskId: TaskId | null;
}

export const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function projectTasks(catalog: TaskCatalog, projectId: ProjectId): Task[] {
  const project = catalog.projects.find((item) => item.id === projectId);
  if (!project) return [];
  const byId = new Map(catalog.tasks.map((item) => [item.id, item]));
  return project.taskOrder.flatMap((id) => byId.get(id) ?? []);
}

export function activeTasks(catalog: TaskCatalog, projectId: ProjectId): Task[] {
  return projectTasks(catalog, projectId).filter((task) => task.lifecycle === "active");
}

/** Completed tasks are history, except currently running work which is always visible. */
export function shouldHideCompletedTask(
  task: Task,
  lastActivityAt: number | null | undefined,
  running: boolean,
  now = Date.now(),
): boolean {
  return (
    task.lifecycle === "completed" &&
    !running &&
    lastActivityAt !== undefined &&
    lastActivityAt !== null &&
    now - lastActivityAt >= TWO_DAYS_MS
  );
}

export function visibleTasks(
  catalog: TaskCatalog,
  projectId: ProjectId,
  activity: Record<TaskId, { lastActivityAt?: number; running?: boolean }> = {},
  now = Date.now(),
): Task[] {
  return projectTasks(catalog, projectId).filter((task) => {
    const status = activity[task.id];
    return !shouldHideCompletedTask(task, status?.lastActivityAt, status?.running === true, now);
  });
}

/** A new shared pane is appended to the shared order and placed at the end locally. */
export function addSharedPane(
  catalog: TaskCatalog,
  local: TaskInterfaceState,
  pane: TaskPane,
): { catalog: TaskCatalog; local: TaskInterfaceState } {
  const task = catalog.tasks.find((item) => item.id === pane.taskId);
  if (!task || catalog.panes.some((item) => item.id === pane.id)) return { catalog, local };
  return {
    catalog: {
      ...catalog,
      panes: [...catalog.panes, pane],
      tasks: catalog.tasks.map((item) =>
        item.id === pane.taskId
          ? { ...item, paneOrder: [...item.paneOrder, pane.id], revision: item.revision + 1 }
          : item,
      ),
    },
    local: {
      ...local,
      paneOrderByTask: {
        ...local.paneOrderByTask,
        [pane.taskId]: [...(local.paneOrderByTask[pane.taskId] ?? []), pane.id],
      },
    },
  };
}

/** Removes stale local references while preserving local ordering for shared panes. */
export function reconcileLocalPaneOrder(
  catalog: TaskCatalog,
  local: TaskInterfaceState,
  taskId: TaskId,
): TaskInterfaceState {
  const shared = catalog.tasks.find((item) => item.id === taskId)?.paneOrder ?? [];
  const allowed = new Set(shared);
  const seen = new Set<string>();
  const current = local.paneOrderByTask[taskId] ?? [];
  const order = [
    ...current.filter((id) => allowed.has(id) && !seen.has(id) && (seen.add(id), true)),
    ...shared.filter((id) => !seen.has(id)),
  ];
  return {
    ...local,
    paneOrderByTask: { ...local.paneOrderByTask, [taskId]: order },
    hiddenPaneIds: local.hiddenPaneIds.filter((id) => allowed.has(id)),
  };
}

export function reorderSharedPane(
  catalog: TaskCatalog,
  taskId: TaskId,
  from: number,
  to: number,
): TaskCatalog {
  const task = catalog.tasks.find((item) => item.id === taskId);
  if (
    !task ||
    from < 0 ||
    to < 0 ||
    from >= task.paneOrder.length ||
    to >= task.paneOrder.length ||
    from === to
  )
    return catalog;
  const paneOrder = [...task.paneOrder];
  const [pane] = paneOrder.splice(from, 1);
  if (!pane) return catalog;
  paneOrder.splice(to, 0, pane);
  return {
    ...catalog,
    tasks: catalog.tasks.map((item) =>
      item.id === taskId ? { ...item, paneOrder, revision: item.revision + 1 } : item,
    ),
  };
}

/** Work on a historical task is a reactivation, never a spawned historical session. */
export function reactivateTask(catalog: TaskCatalog, taskId: TaskId): TaskCatalog {
  return {
    ...catalog,
    tasks: catalog.tasks.map((task) =>
      task.id === taskId ? { ...task, lifecycle: "active", revision: task.revision + 1 } : task,
    ),
  };
}

export function completeTask(catalog: TaskCatalog, taskId: TaskId): TaskCatalog {
  return {
    ...catalog,
    tasks: catalog.tasks.map((task) =>
      task.id === taskId ? { ...task, lifecycle: "completed", revision: task.revision + 1 } : task,
    ),
  };
}

/** Explicit selection only: callers must not silently choose an online substitute. */
export function createTaskRequest(
  projectId: ProjectId,
  title: string,
  deviceId: DeviceId | null,
  defaultBranch: string,
  deviceOnline: boolean,
): { projectId: ProjectId; title: string; deviceId: DeviceId; baseCommit: string } | null {
  const normalized = title.trim();
  if (!normalized || !deviceId || !deviceOnline) return null;
  return { projectId, title: normalized, deviceId, baseCommit: defaultBranch };
}
