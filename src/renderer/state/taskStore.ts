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
  return { ...emptyLocal, ...saved, paneOrderByTask: {} };
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
    let previous = get().local;
    let localRevision = get().localRevision;
    if (!get().loaded) {
      const saved = await window.swath.localState.load(snapshot.network.id);
      if (saved?.state && typeof saved.state === "object") {
        // Pane order belongs to the server catalog. This field is only an in-flight optimistic
        // overlay; persisting it across a crash/upgrade can indefinitely mask committed moves.
        previous = hydrateTaskInterfaceState(saved.state as Partial<TaskInterfaceState>);
        localRevision = saved.revision;
      }
    }
    const activeProjectId = catalog.projects.some((p) => p.id === previous.activeProjectId)
      ? previous.activeProjectId
      : (catalog.projects[0]?.id ?? null);
    const activeTaskId = catalog.tasks.some((t) => t.id === previous.activeTaskId)
      ? previous.activeTaskId
      : (catalog.tasks.find((t) => t.projectId === activeProjectId)?.id ?? null);
    set({
      catalog,
      devices: raw.devices ?? snapshot.devices,
      members: raw.members ?? snapshot.members ?? [],
      networkId: snapshot.network.id,
      local: { ...previous, activeProjectId, activeTaskId },
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

// Serialize interface-state writes: revision fencing rejects a later write if it reaches native
// storage before the earlier revision has committed.
let saveQueue = Promise.resolve();
useTaskStore.subscribe((state, previous) => {
  if (!state.networkId || state.local === previous.local) return;
  const { networkId, local } = state;
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(async () => {
      const current = useTaskStore.getState();
      if (current.networkId !== networkId) return;
      const saved = await window.swath.localState.save(
        networkId,
        { ...local, paneOrderByTask: {} },
        current.localRevision + 1,
      );
      if (useTaskStore.getState().networkId === networkId)
        useTaskStore.setState({ localRevision: saved });
    });
});
