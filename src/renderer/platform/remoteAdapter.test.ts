import { afterEach, expect, it, vi } from "vitest";
import { createHybridSwath, createRemoteWebSwath } from "./remoteAdapter";
import { createBrowserStubSwath } from "./browserFixture";
import { toRemotePath } from "../../shared/ipc/remote";

afterEach(() => vi.unstubAllGlobals());

it("rejects in-flight connection attempts when their device is forgotten", async () => {
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    close(): void {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    send(): void {
      throw new Error("must not send before connected");
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const local = createBrowserStubSwath();
  const config = await local.config.load();
  config.remoteConnections = [
    {
      id: "device",
      name: "Device",
      url: "https://device.test",
      token: "",
      machineId: "machine",
      platform: "linux",
      lastConnectedAt: 0,
    },
  ];
  await local.config.save(config);
  const write = vi.spyOn(local.terminal, "write");
  const api = createHybridSwath(local);
  await api.config.load();
  const attaching = api.terminal.attach({
    sessionId: "connecting",
    cwd: toRemotePath("device", "/work"),
    cols: 80,
    rows: 24,
  });
  const writing = api.terminal.write("connecting", "clipboard text");
  api.remote.forget("device");
  await expect(attaching).rejects.toThrow("Could not connect");
  await expect(writing).rejects.toThrow("Could not connect");
  expect(write).not.toHaveBeenCalled();
});

it("routes the hosted web folder picker to its own connector", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = Socket.OPEN;

    constructor(_url: string, _protocols: string[]) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(data: string): void {
      const request = JSON.parse(data) as { id: number; method: string; params: unknown };
      requests.push(request);
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "response",
              id: request.id,
              result: { path: "/projects", parent: "/", folders: [], locations: [] },
            }),
          }),
        ),
      );
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { origin: "https://host.example" });

  const api = createRemoteWebSwath();
  expect((await api.remote.listFolders("host")).path).toBe("/projects");
  expect((await api.remote.createFolder("host", "/projects", "new project")).path).toBe(
    "/projects",
  );
  expect(requests).toEqual([
    { type: "request", id: 1, method: "directories.list", params: {} },
    {
      type: "request",
      id: 2,
      method: "directories.create",
      params: { path: "/projects", name: "new project" },
    },
  ]);
});

it("never routes remote terminal sessions to local after failure, forget, or concurrent calls", async () => {
  const { createHybridSwath } = await import("./remoteAdapter");
  const { toRemotePath } = await import("../../shared/ipc/remote");
  const localCalls = vi.fn();
  const local = {
    config: {
      load: async () => ({
        remoteConnections: [{ id: "device", url: "https://device.test", token: "" }],
      }),
      snapshot: async () => ({ config: {}, revision: 0 }),
    },
    terminal: {
      ...Object.fromEntries(
        [
          "create",
          "write",
          "resize",
          "kill",
          "attach",
          "restart",
          "replay",
          "setStreaming",
          "isBusy",
        ].map((key) => [key, localCalls]),
      ),
      onData: vi.fn(),
      onExit: vi.fn(),
    },
    git: { onData: vi.fn() },
    pi: { onEvent: vi.fn() },
  } as unknown as Parameters<typeof createHybridSwath>[0];
  const requests: string[] = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    constructor(_url: string, _protocols: string[]) {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(data: string): void {
      const request = JSON.parse(data) as { id: number; method: string };
      requests.push(request.method);
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "response",
              id: request.id,
              ...(request.method === "terminal.create"
                ? { error: "failed" }
                : { result: { running: true } }),
            }),
          }),
        ),
      );
    }
    close(): void {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const api = createHybridSwath(local);
  await api.config.load();
  const request = {
    sessionId: "session",
    cwd: toRemotePath("device", "/work"),
    cols: 80,
    rows: 24,
  };
  await expect(
    api.terminal.create(request as Parameters<typeof api.terminal.create>[0]),
  ).rejects.toThrow("failed");
  await Promise.all([api.terminal.attach(request), api.terminal.write("session", "data")]);
  api.terminal.resize({ sessionId: "session", cols: 80, rows: 24 });
  api.terminal.setStreaming("session", true);
  api.terminal.kill("session");
  expect(await api.terminal.restart("session")).toEqual({ running: true });
  expect(await api.terminal.replay("session")).toEqual({ running: true });
  expect(await api.terminal.isBusy("session")).toEqual({ running: true });
  expect(requests).toContain("terminal.write");
  expect(localCalls).not.toHaveBeenCalled();
  api.remote.forget("device");
  await expect(api.terminal.write("session", "data")).rejects.toThrow("not configured");
  await expect(api.terminal.attach(request)).rejects.toThrow("not configured");
  await expect(
    api.terminal.create({ ...request, sessionId: "unknown" } as Parameters<
      typeof api.terminal.create
    >[0]),
  ).rejects.toThrow("not configured");
  await expect(
    api.terminal.create({ ...request, cwd: "/work" } as Parameters<typeof api.terminal.create>[0]),
  ).rejects.toThrow("belongs to a remote");
  expect(() => api.terminal.resize({ sessionId: "session", cols: 80, rows: 24 })).toThrow(
    "not configured",
  );
  expect(() => api.terminal.kill("session")).toThrow("not configured");
  expect(() => api.terminal.setStreaming("session", true)).toThrow("not configured");
  await expect(api.terminal.restart("session")).rejects.toThrow("not configured");
  await expect(api.terminal.replay("session")).rejects.toThrow("not configured");
  await expect(api.terminal.isBusy("session")).rejects.toThrow("not configured");
  await expect(
    api.terminal.create({
      ...request,
      sessionId: "malformed",
      cwd: "swath-remote://broken",
    } as Parameters<typeof api.terminal.create>[0]),
  ).rejects.toThrow("Invalid remote");
  expect(localCalls).not.toHaveBeenCalled();
});
