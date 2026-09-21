import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateTaskInterfaceState, useTaskStore } from "./taskStore";

const snapshot = {
  network: { id: "network", name: "Network", schemaVersion: 2 as const, revision: 1, createdAt: 0 },
  devices: [],
  members: [],
};

function installTaskWindow(
  localState: Pick<NonNullable<Window["swath"]>["localState"], "load" | "save">,
): void {
  globalThis.window = {
    swath: {
      network: { current: vi.fn(async () => snapshot) },
      tasks: { rpc: vi.fn(async () => ({ projects: [], tasks: [], panes: [] })) },
      localState,
    },
  } as unknown as Window & typeof globalThis;
}

async function flushPersistence(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  useTaskStore.setState(useTaskStore.getInitialState(), true);
});

describe("task interface state hydration", () => {
  it("preserves selection and drafts but discards obsolete pane order overrides", () => {
    const state = hydrateTaskInterfaceState({
      activeTaskId: "task",
      drafts: { pane: "unsent text" },
      paneOrderByTask: { task: ["old", "order"] },
    });
    expect(state.activeTaskId).toBe("task");
    expect(state.drafts).toEqual({ pane: "unsent text" });
    expect(state.paneOrderByTask).toEqual({});
  });

  it("does not save when a catalog reconcile leaves local state unchanged", async () => {
    const save = vi.fn(async (_networkId: string, _state: unknown, revision: number) => revision);
    installTaskWindow({
      load: vi.fn(async () => ({ revision: 4, state: hydrateTaskInterfaceState({}) })),
      save,
    });

    await useTaskStore.getState().refresh();
    await useTaskStore.getState().refresh();
    await flushPersistence();

    expect(save).not.toHaveBeenCalled();
  });

  it("reloads the winning revision and retries after a revision conflict", async () => {
    const save = vi
      .fn<NonNullable<Window["swath"]>["localState"]["save"]>()
      .mockRejectedValueOnce(new Error("local interface state revision conflict"))
      .mockResolvedValueOnce(7);
    const load = vi
      .fn<NonNullable<Window["swath"]>["localState"]["load"]>()
      .mockResolvedValueOnce({ revision: 4, state: hydrateTaskInterfaceState({}) })
      .mockResolvedValueOnce({ revision: 6, state: hydrateTaskInterfaceState({}) });
    installTaskWindow({ load, save });

    await useTaskStore.getState().refresh();
    useTaskStore.getState().setFocusedPane("pane");
    await flushPersistence();
    await flushPersistence();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[2]).toBe(5);
    expect(save.mock.calls[1]?.[2]).toBe(7);
    expect(save.mock.calls[1]?.[1]).toMatchObject({
      focusedPaneId: "pane",
      paneOrderByTask: {},
      hiddenPaneIds: [],
      drafts: {},
      historicalTaskId: null,
    });
    expect(useTaskStore.getState().localRevision).toBe(7);
  });
});
