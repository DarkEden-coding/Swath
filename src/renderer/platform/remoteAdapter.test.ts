import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createHybridSwath, createRemoteWebSwath } from "./remoteAdapter";
import { createBrowserStubSwath } from "./browserFixture";
import { toRemotePath } from "../../shared/ipc/remote";

beforeEach(() => {
  vi.useFakeTimers();
  const windowTarget = new EventTarget();
  vi.stubGlobal(
    "window",
    Object.assign(windowTarget, {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    }),
  );
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

function hostedSocket(options: { open?: boolean; respond?: boolean } = {}) {
  const sockets: Socket[] = [];
  const requests: Array<{ id: number; method: string }> = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      if (options.open !== false)
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        });
    }
    send(raw: string): void {
      const request = JSON.parse(raw) as { id: number; method: string };
      requests.push(request);
      if (options.respond)
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "response", id: request.id, result: { ok: true } }),
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
  vi.stubGlobal("location", { origin: "https://host.test" });
  return { api: createRemoteWebSwath(), sockets, requests, options };
}

it("times out stalled socket opens, closes them, and keeps reconnecting", async () => {
  const { api, sockets } = hostedSocket({ open: false });
  const result = expect(api.config.load()).rejects.toThrow("Could not connect");
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
  expect(sockets[0].readyState).toBe(3);
  expect(api.remote.status("host")).toBe("offline");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sockets).toHaveLength(2);
  expect(api.remote.status("host")).toBe("connecting");
});

it("detects a silent dead socket via ping and reconnects without user activity", async () => {
  const { api, sockets, requests, options } = hostedSocket({ respond: true });
  await api.config.load();
  options.respond = false;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(requests.map((r) => r.method)).toEqual(["config.load", "connection.ping"]);
  expect(sockets[0].readyState).toBe(3);
  expect(api.remote.status("host")).toBe("offline");
  options.respond = true;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(api.remote.status("host")).toBe("connected");
});

it("bounds unanswered mutations, rejects other pending calls, and never replays them", async () => {
  const { api, sockets, requests, options } = hostedSocket({ respond: true });
  await api.config.load();
  options.respond = false;
  const mutation = expect(api.terminal.write("session", "run-command\n")).rejects.toThrow(
    "not retried",
  );
  await vi.advanceTimersByTimeAsync(1_000);
  const other = expect(api.config.snapshot()).rejects.toThrow("disconnected");
  await vi.advanceTimersByTimeAsync(29_000);
  await Promise.all([mutation, other]);
  expect(sockets[0].readyState).toBe(3);
  options.respond = true;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(requests.filter((r) => r.method === "terminal.write")).toHaveLength(1);
  expect(requests.filter((r) => r.method === "config.snapshot")).toHaveLength(1);
});

it("replaces a stale socket after browser sleep and removes timers/listeners on forget", async () => {
  const { api, sockets } = hostedSocket({ respond: true });
  await api.config.load();
  vi.setSystemTime(Date.now() + 60_000);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(sockets[0].readyState).toBe(3);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(api.remote.status("host")).toBe("connected");

  const local = createBrowserStubSwath();
  const config = await local.config.load();
  config.remoteConnections = [
    {
      id: "device",
      name: "Device",
      url: "https://device.test",
      token: "",
      machineId: "device",
      platform: "linux",
      lastConnectedAt: 0,
    },
  ];
  await local.config.save(config);
  const hybrid = createHybridSwath(local);
  await hybrid.config.load();
  await Promise.resolve();
  const socket = sockets.at(-1)!;
  hybrid.remote.forget("device");
  const count = sockets.length;
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(socket.readyState).toBe(3);
  expect(sockets).toHaveLength(count);
});
