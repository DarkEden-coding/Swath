import { create } from "zustand";
import type { Device, Project, Task, TaskPane } from "../../shared/types";
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

type TaskReply = { ok?: boolean; projects?: Project[]; tasks?: Task[]; panes?: TaskPane[] };

interface TaskState {
  catalog: TaskCatalog;
  devices: Device[];
  networkId: string | null;
  local: TaskInterfaceState;
  loaded: boolean;
  localRevision: number;
  refresh: () => Promise<void>;
  selectProject: (id: string) => void;
  selectTask: (id: string, historical?: boolean) => void;
  setFocusedPane: (id: string | null) => void;
  setDraft: (paneId: string, draft: string) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  catalog: emptyCatalog,
  devices: [],
  networkId: null,
  local: emptyLocal,
  loaded: false,
  localRevision: 0,
  refresh: async () => {
    // Startup must not create catalog state. The gate explicitly initializes or joins.
    const snapshot = await window.swath.network.current();
    if (!snapshot) {
      set({ catalog: emptyCatalog, devices: [], networkId: null, loaded: true });
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
        previous = { ...emptyLocal, ...(saved.state as Partial<TaskInterfaceState>) };
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
      devices: snapshot.devices,
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
  setDraft: (paneId, draft) =>
    set((state) => ({
      local: { ...state.local, drafts: { ...state.local.drafts, [paneId]: draft } },
    })),
}));

// Revision fencing makes stale asynchronous saves harmless to native and browser backends.
let saving = 0;
useTaskStore.subscribe((state, previous) => {
  if (!state.networkId || state.local === previous.local) return;
  const revision = Math.max(state.localRevision + 1, ++saving);
  void window.swath.localState.save(state.networkId, state.local, revision).then((saved) => {
    if (
      useTaskStore.getState().networkId === state.networkId &&
      saved >= useTaskStore.getState().localRevision
    )
      useTaskStore.setState({ localRevision: saved });
  });
});
