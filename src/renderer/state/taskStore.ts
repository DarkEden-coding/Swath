import { create } from "zustand";
import type { Device, NetworkMember, Project, Task, TaskPane } from "../../shared/types";
import type { TaskCatalog, TaskInterfaceState } from "../domain/tasks/taskActions";

const emptyCatalog: TaskCatalog = { projects: [], tasks: [], panes: [] };
const emptyLocal: TaskInterfaceState = {
  activeProjectId: null,
  activeTaskId: null,
  focusedPaneId: null,
  paneOrderByTask: {},
  hiddenPaneIds: [],
  drafts: {},
  historicalTaskId: null,
};

/** Local pane order is an optimistic overlay, never an authority across process restarts. */
export function hydrateTaskInterfaceState(saved: Partial<TaskInterfaceState>): TaskInterfaceState {
  // Keep the persisted representation explicit. In particular, an older state record may omit
  // optional fields (or contain the server-owned pane order), but neither should leak an
  // undefined value or an optimistic order into the live interface state.
  return {
    activeProjectId: saved.activeProjectId ?? null,
    activeTaskId: saved.activeTaskId ?? null,
    focusedPaneId: saved.focusedPaneId ?? null,
    paneOrderByTask: {},
    hiddenPaneIds: saved.hiddenPaneIds ?? [],
    drafts: saved.drafts ?? {},
    historicalTaskId: saved.historicalTaskId ?? null,
  };
}

/** Compare the small, JSON-shaped interface state without relying on object identity. */
function sameTaskInterfaceState(a: TaskInterfaceState, b: TaskInterfaceState): boolean {
  return (
    a.activeProjectId === b.activeProjectId &&
    a.activeTaskId === b.activeTaskId &&
    a.focusedPaneId === b.focusedPaneId &&
    a.historicalTaskId === b.historicalTaskId &&
    a.hiddenPaneIds.length === b.hiddenPaneIds.length &&
    a.hiddenPaneIds.every((id, index) => id === b.hiddenPaneIds[index]) &&
    Object.keys(a.paneOrderByTask).length === Object.keys(b.paneOrderByTask).length &&
    Object.keys(a.paneOrderByTask).every(
      (taskId) =>
        a.paneOrderByTask[taskId]?.length === b.paneOrderByTask[taskId]?.length &&
        a.paneOrderByTask[taskId]?.every(
          (paneId, index) => paneId === b.paneOrderByTask[taskId]?.[index],
        ),
    ) &&
    Object.keys(a.drafts ?? {}).length === Object.keys(b.drafts ?? {}).length &&
    Object.keys(a.drafts ?? {}).every((paneId) => a.drafts?.[paneId] === b.drafts?.[paneId])
  );
}

/** Do not let the server-owned pane order become a second local authority. */
function persistableTaskInterfaceState(local: TaskInterfaceState): TaskInterfaceState {
  return { ...hydrateTaskInterfaceState(local), paneOrderByTask: {} };
}

type TaskReply = {
  ok?: boolean;
  projects?: Project[];
  tasks?: Task[];
  panes?: TaskPane[];
  devices?: Device[];
  members?: NetworkMember[];
};

interface TaskState {
  catalog: TaskCatalog;
  devices: Device[];
  members: NetworkMember[];
  networkId: string | null;
  local: TaskInterfaceState;
  loaded: boolean;
  localRevision: number;
  refresh: () => Promise<void>;
  selectProject: (id: string) => void;
  selectTask: (id: string, historical?: boolean) => void;
  setFocusedPane: (id: string | null) => void;
  movePane: (taskId: string, fromIndex: number, toIndex: number) => void;
  setPaneOrderOverride: (taskId: string, order: string[] | null) => void;
  setDraft: (paneId: string, draft: string) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  catalog: emptyCatalog,
  devices: [],
  members: [],
  networkId: null,
  local: emptyLocal,
  loaded: false,
  localRevision: 0,
  refresh: async () => {
    // Startup must not create catalog state. The gate explicitly initializes or joins.
    const snapshot = await window.swath.network.current();
    if (!snapshot) {
      set({ catalog: emptyCatalog, devices: [], members: [], networkId: null, loaded: true });
      return;
    }
    const raw = (await window.swath.tasks.rpc({
      op: "listCatalog",
      networkId: snapshot.network.id,
    })) as TaskReply;
    const catalog = {
      projects: raw.projects ?? [],
      tasks: raw.tasks ?? [],
      panes: raw.panes ?? [],
    };
    const current = get();
    let previous = current.local;
    let localRevision = current.localRevision;
    // A refresh after a network switch must hydrate that network's interface state. During the
    // normal reconcile loop, retain the current object so an unchanged poll cannot enqueue a save.
    if (!current.loaded || current.networkId !== snapshot.network.id) {
      const saved = await window.swath.localState.load(snapshot.network.id);
      if (saved?.state && typeof saved.state === "object") {
        // Pane order belongs to the server catalog. This field is only an in-flight optimistic
        // overlay; persisting it across a crash/upgrade can indefinitely mask committed moves.
        previous = hydrateTaskInterfaceState(saved.state as Partial<TaskInterfaceState>);
        localRevision = saved.revision;
      } else {
        previous = emptyLocal;
        localRevision = 0;
      }
    }
    const activeProjectId = catalog.projects.some((p) => p.id === previous.activeProjectId)
      ? previous.activeProjectId
      : (catalog.projects[0]?.id ?? null);
    const activeTaskId = catalog.tasks.some((t) => t.id === previous.activeTaskId)
      ? previous.activeTaskId
      : (catalog.tasks.find((t) => t.projectId === activeProjectId)?.id ?? null);
    const local =
      activeProjectId === previous.activeProjectId && activeTaskId === previous.activeTaskId
        ? previous
        : { ...previous, activeProjectId, activeTaskId };
    set({
      catalog,
      devices: raw.devices ?? snapshot.devices,
      members: raw.members ?? snapshot.members ?? [],
      networkId: snapshot.network.id,
      local,
      localRevision,
      loaded: true,
    });
  },
  selectProject: (id) =>
    set((state) => ({
      local: {
        ...state.local,
        activeProjectId: id,
        activeTaskId:
          state.catalog.tasks.find((t) => t.projectId === id && t.lifecycle === "active")?.id ??
          null,
        historicalTaskId: null,
      },
    })),
  selectTask: (id, historical = false) =>
    set((state) => ({
      local: {
        ...state.local,
        activeTaskId: historical ? null : id,
        historicalTaskId: historical ? id : null,
      },
    })),
  setFocusedPane: (id) => set((state) => ({ local: { ...state.local, focusedPaneId: id } })),
  movePane: (taskId, fromIndex, toIndex) =>
    set((state) => {
      const shared = state.catalog.tasks.find((task) => task.id === taskId)?.paneOrder ?? [];
      const current = state.local.paneOrderByTask[taskId] ?? shared;
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= current.length ||
        toIndex >= current.length ||
        fromIndex === toIndex
      )
        return state;
      const order = [...current];
      const [paneId] = order.splice(fromIndex, 1);
      if (!paneId) return state;
      order.splice(toIndex, 0, paneId);
      return {
        local: {
          ...state.local,
          paneOrderByTask: { ...state.local.paneOrderByTask, [taskId]: order },
        },
      };
    }),
  setPaneOrderOverride: (taskId, order) =>
    set((state) => {
      const paneOrderByTask = { ...state.local.paneOrderByTask };
      if (order) paneOrderByTask[taskId] = order;
      else delete paneOrderByTask[taskId];
      return { local: { ...state.local, paneOrderByTask } };
    }),
  setDraft: (paneId, draft) =>
    set((state) => ({
      local: { ...state.local, drafts: { ...state.local.drafts, [paneId]: draft } },
    })),
}));

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "";
  } catch {
    return "";
  }
}

function isRevisionConflict(error: unknown): boolean {
  return /revision[ _-]?conflict|reload before saving/i.test(errorMessage(error));
}

function revisionFromError(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const revision = (error as { revision?: unknown }).revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0
    ? revision
    : null;
}

/**
 * Persist the newest local snapshot and recover the CAS watermark if another window won the
 * race. The native adapter currently reports conflicts as a string, while test/browser
 * adapters may return a structured error, so both forms are accepted here.
 */
async function persistTaskInterfaceState(networkId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = useTaskStore.getState();
    if (current.networkId !== networkId) return;

    const expectedRevision = current.localRevision + 1;
    try {
      const savedRevision = await window.swath.localState.save(
        networkId,
        persistableTaskInterfaceState(current.local),
        expectedRevision,
      );
      const latest = useTaskStore.getState();
      if (latest.networkId === networkId) {
        useTaskStore.setState({
          localRevision:
            typeof savedRevision === "number" && Number.isFinite(savedRevision)
              ? savedRevision
              : expectedRevision,
        });
      }
      return;
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;

      // The conflict response from native storage does not include the winning revision, so
      // reload it before retrying. Prefer a revision carried by structured adapters when present.
      const conflictRevision = revisionFromError(error);
      const latest = await window.swath.localState.load(networkId);
      const recoveredRevision =
        conflictRevision ?? (latest && Number.isFinite(latest.revision) ? latest.revision : 0);
      if (useTaskStore.getState().networkId !== networkId) return;
      useTaskStore.setState({ localRevision: recoveredRevision });
    }
  }
}

// Serialize interface-state writes: revision fencing rejects a later write if it reaches native
// storage before the earlier revision has committed. A queue item reads the latest state when it
// runs, so quick successive edits are not persisted as stale snapshots.
let saveQueue: Promise<void> = Promise.resolve();
useTaskStore.subscribe((state, previous) => {
  if (!state.networkId) return;
  // Refresh creates new catalog objects, and pane-order overlays are intentionally not persisted.
  // Compare the persisted shape rather than object identity to avoid a write on every poll.
  if (
    sameTaskInterfaceState(
      persistableTaskInterfaceState(state.local),
      persistableTaskInterfaceState(previous.local),
    )
  )
    return;
  const { networkId } = state;
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => persistTaskInterfaceState(networkId))
    .catch(() => undefined);
});
