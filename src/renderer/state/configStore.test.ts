import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../shared/types";
import type { ConfigSnapshot, SwathApi } from "../../shared/ipc/swath";

const fixture = (): AppConfig => ({
  version: 2,
  activeWorkspaceId: "ws",
  workspaces: [
    {
      id: "ws",
      name: "Original",
      path: "/repo",
      createdAt: 0,
      updatedAt: 0,
      activeViewId: "v1",
      views: [
        {
          id: "v1",
          title: "One",
          layout: { type: "pane", id: "p1", kind: "terminal" },
          activePaneId: "p1",
        },
        {
          id: "v2",
          title: "Two",
          layout: { type: "pane", id: "p2", kind: "terminal" },
          activePaneId: "p2",
        },
      ],
    },
  ],
  settings: {
    fontFamily: "mono",
    fontSize: 13,
    lineHeight: 1.1,
    cursorBlink: true,
    cursorStyle: "block",
    defaultShellProfileId: "sh",
    shellProfiles: [{ id: "sh", name: "sh", command: "/bin/sh", args: [] }],
    globalEnv: {},
    confirmBeforeClosingPane: false,
  },
  remoteConnections: [
    {
      id: "remote",
      name: "Server",
      url: "https://remote.test",
      token: "secret",
      machineId: "machine",
      platform: "linux",
      lastConnectedAt: 0,
    },
  ],
});

async function setup() {
  vi.resetModules();
  let server: ConfigSnapshot = { config: fixture(), revision: 1 };
  let changed: (event: { revision: number }) => void = () => {};
  const snapshot = vi.fn(async () => structuredClone(server));
  const commit = vi.fn(async (request: ConfigSnapshot) => {
    if (request.revision !== server.revision) throw new Error("conflict");
    server = { config: structuredClone(request.config), revision: server.revision + 1 };
    changed({ revision: server.revision });
    return structuredClone(server);
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      swath: {
        platform: "darwin",
        config: {
          snapshot,
          commit,
          onChanged: (callback: typeof changed) => {
            changed = callback;
            return () => {};
          },
        },
      } satisfies Pick<SwathApi, "platform"> & {
        config: Pick<SwathApi["config"], "snapshot" | "commit" | "onChanged">;
      },
    },
  });
  const { useConfigStore } = await import("./configStore");
  return {
    store: useConfigStore,
    snapshot,
    commit,
    external(config: AppConfig) {
      server = { config, revision: server.revision + 1 };
      changed({ revision: server.revision });
    },
    get server() {
      return server;
    },
  };
}

beforeEach(() => vi.restoreAllMocks());

describe("configStore synchronization", () => {
  it("hydrates native remote connections from the first snapshot", async () => {
    const { store } = await setup();
    await store.getState().hydrate();
    expect(store.getState().config?.remoteConnections).toEqual(fixture().remoteConnections);
  });

  it("serializes independent mutations and replays a conflicting operation on the latest revision", async () => {
    const host = await setup();
    await host.store.getState().hydrate();
    host.store
      .getState()
      .mutate((config) => ({
        ...config,
        workspaces: config.workspaces.map((ws) => ({ ...ws, name: "Local" })),
      }));
    host.store
      .getState()
      .mutate((config) => ({ ...config, settings: { ...config.settings, fontSize: 18 } }));
    host.external({ ...fixture(), settings: { ...fixture().settings, fontFamily: "external" } });
    await host.store.getState().save();
    expect(host.commit.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(host.server.config.workspaces[0]?.name).toBe("Local");
    expect(host.server.config.settings).toMatchObject({ fontSize: 18, fontFamily: "external" });
    expect(host.store.getState().config?.settings).toMatchObject({
      fontSize: 18,
      fontFamily: "external",
    });
  });

  it("refreshes external changes without overwriting local view navigation", async () => {
    const host = await setup();
    await host.store.getState().hydrate();
    const local = structuredClone(host.store.getState().config!);
    local.workspaces[0]!.activeViewId = "v2";
    host.store.getState().setConfig(local);
    host.external({
      ...fixture(),
      workspaces: [{ ...fixture().workspaces[0]!, name: "External" }],
    });
    await vi.waitFor(() =>
      expect(host.store.getState().config?.workspaces[0]?.name).toBe("External"),
    );
    expect(host.store.getState().config?.workspaces[0]?.activeViewId).toBe("v2");
  });
});
