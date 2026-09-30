import type { SwathApi, RemoteHandshake, RemoteServerStatus } from "../../shared/ipc/swath";
import type { RemoteConnection } from "../../shared/types";
import type { RemoteEvent, RemoteMethod, RemoteResponse } from "../../shared/ipc/remote";
import { parseRemotePath } from "../../shared/ipc/remote";
import { readBrowserClipboard } from "./browserClipboard";

type Status = "connected" | "connecting" | "offline";
type EventChannel = RemoteEvent["channel"];

function normalizeUrl(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function socketUrl(baseUrl: string): string {
  const url = new URL("/api/socket", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function authProtocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return `auth.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

class RemoteClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private retry: number | null = null;
  private heartbeat: number | null = null;
  private probing = false;
  private lastProbe = 0;
  private readonly wake = (): void => {
    if (document.visibilityState === "hidden" || !this.active) return;
    if (this.status === "connected") {
      // A suspended browser cannot trust the old socket after a long clock gap.
      if (Date.now() - this.lastProbe > 30_000) this.disconnect();
      else void this.probe();
    } else void this.open().catch(() => undefined);
  };
  private active = false;
  private disposed = false;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }
  >();
  private eventListeners = new Set<(event: RemoteEvent) => void>();
  private statusListeners = new Set<(status: Status) => void>();
  status: Status = "offline";

  constructor(readonly connection: Pick<RemoteConnection, "id" | "url" | "token">) {}

  onEvent(callback: (event: RemoteEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  onStatus(callback: (status: Status) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  private setStatus(status: Status): void {
    if (status === this.status) return;
    this.status = status;
    this.statusListeners.forEach((listener) => listener(status));
  }

  async open(): Promise<void> {
    if (this.disposed) throw new Error("Remote device is not configured");
    if (!this.active) {
      window.addEventListener("online", this.wake);
      window.addEventListener("pageshow", this.wake);
      document.addEventListener("visibilitychange", this.wake);
    }
    this.active = true;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.socket?.readyState === WebSocket.CONNECTING) return this.waitForOpen(this.socket);
    this.setStatus("connecting");
    const protocols = this.connection.token
      ? ["swath-v1", authProtocol(this.connection.token)]
      : ["swath-v1"];
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl(this.connection.url), protocols);
    } catch (error) {
      this.closed();
      throw error;
    }
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (!this.disposed && this.socket === socket) this.receive(String(event.data));
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.closed();
    });
    await this.waitForOpen(socket);
  }

  /** Reject interrupted connection attempts and remove all losing event listeners. */
  private waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        failed();
      }, 10_000);
      const cleanup = (): void => {
        window.clearTimeout(timer);
        socket.removeEventListener("open", connected);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      const failed = (): void => {
        cleanup();
        reject(new Error(`Could not connect to ${this.connection.url}. Retrying automatically.`));
        if (this.socket === socket) this.disconnect();
      };
      const connected = (): void => {
        if (this.disposed || this.socket !== socket) {
          failed();
          return;
        }
        cleanup();
        if (this.retry !== null) window.clearTimeout(this.retry);
        this.retry = null;
        this.lastProbe = Date.now();
        if (this.heartbeat === null)
          this.heartbeat = window.setInterval(() => void this.probe(), 10_000);
        this.setStatus("connected");
        resolve();
      };
      socket.addEventListener("open", connected, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
    });
  }

  close(): void {
    this.disposed = true;
    this.active = false;
    window.removeEventListener("online", this.wake);
    window.removeEventListener("pageshow", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
    if (this.retry !== null) window.clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.closed();
    socket?.close();
  }

  /** Invalidates the socket and rejects interrupted calls before scheduling reconnection. */
  private disconnect(): void {
    const socket = this.socket;
    this.closed();
    socket?.close();
  }

  /** Checks idle connection liveness without queueing behind an existing host request. */
  private async probe(): Promise<void> {
    if (this.probing || this.status !== "connected" || this.pending.size > 0) return;
    this.probing = true;
    const socket = this.socket;
    this.lastProbe = Date.now();
    try {
      await this.call("connection.ping", undefined, 5_000);
    } catch {
      if (this.socket === socket) this.disconnect();
    } finally {
      this.probing = false;
    }
  }

  private closed(): void {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.socket = null;
    this.setStatus("offline");
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(
        new Error(
          "Remote device disconnected. Reconnecting automatically; the operation was not retried. Check its outcome before trying again.",
        ),
      );
    }
    this.pending.clear();
    if (this.active && this.retry === null) {
      this.retry = window.setTimeout(() => {
        this.retry = null;
        void this.open().catch(() => undefined);
      }, 2_000);
    }
  }

  private receive(raw: string): void {
    let message: RemoteResponse | RemoteEvent;
    try {
      message = JSON.parse(raw) as RemoteResponse | RemoteEvent;
    } catch {
      return;
    }
    if (message.type === "event") {
      this.eventListeners.forEach((listener) => listener(message));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  deliverReplay(sessionId: string, data: string): void {
    if (data)
      this.eventListeners.forEach((listener) =>
        listener({ type: "event", channel: "terminal:data", payload: { sessionId, data } }),
      );
  }

  async call<T>(method: RemoteMethod, params?: unknown, timeout = 30_000): Promise<T> {
    await this.open();
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Remote request ${method} timed out. The operation was not retried; check its outcome before trying again.`,
          ),
        );
        this.disconnect();
      }, timeout);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      if (this.disposed || this.socket?.readyState !== WebSocket.OPEN) {
        window.clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Remote device is not connected"));
        return;
      }
      try {
        this.socket.send(JSON.stringify({ type: "request", id, method, params }));
      } catch (error) {
        window.clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
        this.disconnect();
      }
    });
  }
}

function unroutePath(path: string): string {
  return parseRemotePath(path)?.path ?? path;
}

function unroute<T>(value: T): T {
  if (typeof value === "string") return unroutePath(value) as T;
  if (Array.isArray(value)) return value.map(unroute) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unroute(item)]),
    ) as T;
  }
  return value;
}

function connectionFrom(value: unknown): string | null {
  if (typeof value === "string") return parseRemotePath(value)?.connectionId ?? null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = connectionFrom(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = connectionFrom(item);
      if (found) return found;
    }
  }
  return null;
}

/** Adds low-overhead remote routing to the native bridge without changing feature panes. */
export function createHybridSwath(local: SwathApi): SwathApi {
  const clients = new Map<string, RemoteClient>();
  const terminalOwners = new Map<string, string>();
  const piOwners = new Map<string, string>();
  const statusListeners = new Set<(id: string, status: Status) => void>();
  const eventListeners = new Map<EventChannel, Set<(payload: any) => void>>();

  function client(profile: Pick<RemoteConnection, "id" | "url" | "token">): RemoteClient {
    let found = clients.get(profile.id);
    if (found) return found;
    found = new RemoteClient(profile);
    found.onStatus((status) => statusListeners.forEach((listener) => listener(profile.id, status)));
    found.onEvent((event) =>
      eventListeners.get(event.channel)?.forEach((listener) => listener(event.payload)),
    );
    clients.set(profile.id, found);
    return found;
  }

  function remoteFor(value: unknown): RemoteClient | null {
    const id = connectionFrom(value);
    return id ? (clients.get(id) ?? null) : null;
  }

  /** Resolve a pinned terminal owner without ever falling back to this device. */
  function terminalClient(sessionId: string): RemoteClient | null {
    const id = terminalOwners.get(sessionId);
    if (!id) return null;
    const remote = clients.get(id);
    if (!remote) throw new Error(`Remote device ${id} is not configured`);
    return remote;
  }

  /** Pin remote ownership before I/O so failed or concurrent attaches remain remote. */
  function terminalDestination(request: { cwd: string; sessionId: string }): RemoteClient | null {
    if (!request.cwd.startsWith("swath-remote://")) {
      if (terminalOwners.has(request.sessionId))
        throw new Error("Terminal session belongs to a remote device");
      return null;
    }
    const id = parseRemotePath(request.cwd)?.connectionId;
    if (!id) throw new Error("Invalid remote terminal path");
    if (terminalOwners.has(request.sessionId) && terminalOwners.get(request.sessionId) !== id)
      throw new Error("Terminal session belongs to another remote device");
    terminalOwners.set(request.sessionId, id);
    return terminalClient(request.sessionId);
  }

  function event<T>(
    channel: EventChannel,
    localSubscribe: (callback: T) => () => void,
    pick: (payload: any) => Parameters<T & ((...args: any[]) => any)>,
  ): (callback: T) => () => void {
    return (callback: T) => {
      const set = eventListeners.get(channel) ?? new Set();
      const listener = (payload: any) => (callback as any)(...pick(payload));
      set.add(listener);
      eventListeners.set(channel, set);
      const offLocal = localSubscribe(callback);
      return () => {
        set.delete(listener);
        offLocal();
      };
    };
  }

  function connectProfiles(config: { remoteConnections?: RemoteConnection[] }): void {
    for (const profile of config.remoteConnections ?? []) {
      const remote = client(profile);
      void remote.open().catch(() => undefined);
    }
  }

  const originalLoad = local.config.load;
  local.config.load = async () => {
    const config = await originalLoad();
    connectProfiles(config);
    return config;
  };
  const originalSnapshot = local.config.snapshot;
  local.config.snapshot = async () => {
    const snapshot = await originalSnapshot();
    connectProfiles(snapshot.config);
    return snapshot;
  };

  return {
    ...local,
    config: local.config,
    terminal: {
      create: async (request) => {
        const remote = terminalDestination(request);
        if (!remote) return local.terminal.create(request);
        await remote.call("terminal.create", unroute(request));
      },
      write: async (sessionId, data) => {
        const remote = terminalClient(sessionId);
        return remote
          ? void (await remote.call("terminal.write", { sessionId, data }))
          : local.terminal.write(sessionId, data);
      },
      resize: (request) => {
        const remote = terminalClient(request.sessionId);
        remote
          ? void remote.call("terminal.resize", request).catch(() => undefined)
          : local.terminal.resize(request);
      },
      kill: (sessionId) => {
        const remote = terminalClient(sessionId);
        remote
          ? void remote.call("terminal.kill", { sessionId }).catch(() => undefined)
          : local.terminal.kill(sessionId);
      },
      attach: async (request) => {
        const remote = terminalDestination(request);
        if (!remote) return local.terminal.attach(request);
        return remote.call("terminal.attach", unroute(request));
      },
      restart: async (sessionId) =>
        terminalClient(sessionId)?.call("terminal.restart", { sessionId }) ??
        local.terminal.restart(sessionId),
      replay: async (sessionId) => {
        const remote = terminalClient(sessionId);
        if (!remote) return local.terminal.replay(sessionId);
        const { data, ...status } = await remote.call<{
          data: string;
          sessionId: string;
          running: boolean;
        }>("terminal.replay", { sessionId });
        remote.deliverReplay(sessionId, data);
        return status;
      },
      setStreaming: (sessionId, enabled) => {
        const remote = terminalClient(sessionId);
        remote
          ? void remote.call("terminal.setStreaming", { sessionId, enabled }).catch(() => undefined)
          : local.terminal.setStreaming(sessionId, enabled);
      },
      isBusy: async (sessionId) =>
        terminalClient(sessionId)?.call("terminal.isBusy", { sessionId }) ??
        local.terminal.isBusy(sessionId),
      onData: event("terminal:data", local.terminal.onData, (p) => [p.sessionId, p.data]),
      onExit: event("terminal:exit", local.terminal.onExit, (p) => [
        p.sessionId,
        { exitCode: p.exitCode, signal: p.signal },
      ]),
    },
    git: {
      rpc: async (request) =>
        remoteFor(request)?.call("git.rpc", unroute(request)) ?? local.git.rpc(request),
      onData: event("git:data", local.git.onData, (p) => [p.runId, p.data]),
    },
    files: {
      rpc: async (request) =>
        remoteFor(request)?.call("files.rpc", unroute(request)) ?? local.files.rpc(request),
    },
    askImages: {
      load: async (request) =>
        remoteFor(request)?.call("askImages.load", unroute(request)) ??
        local.askImages.load(request),
    },
    pi: {
      rpc: async (request) => {
        const owner =
          request.op === "spawn" || request.op === "files"
            ? remoteFor(request)
            : (clients.get(piOwners.get(request.paneId) ?? "") ?? null);
        if (!owner) return local.pi.rpc(request);
        if (request.op === "spawn") piOwners.set(request.paneId, owner.connection.id);
        if (request.op === "kill") piOwners.delete(request.paneId);
        return owner.call("pi.rpc", unroute(request));
      },
      onEvent: event("pi:event", local.pi.onEvent, (p) => [p.paneId, p.line, p.exit === true]),
    },
    remote: {
      connect: async (url, token) => {
        const normalized = normalizeUrl(url);
        const response = await fetch(new URL("/api/handshake", normalized), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "Connector authentication failed"
              : `Connector returned ${response.status}`,
          );
        const handshake = (await response.json()) as RemoteHandshake;
        if (handshake.protocol !== 1)
          throw new Error(`Unsupported remote protocol ${handshake.protocol}`);
        const id = handshake.machineId;
        await client({ id, url: normalized, token }).open();
        return handshake;
      },
      forget: (id) => {
        clients.get(id)?.close();
        clients.delete(id);
      },
      status: (id) => clients.get(id)?.status ?? "offline",
      onStatus: (callback) => {
        statusListeners.add(callback);
        return () => statusListeners.delete(callback);
      },
      listFolders: async (connectionId, path) => {
        const remote = clients.get(connectionId);
        if (!remote) throw new Error("Remote device is not configured");
        return remote.call("directories.list", path ? { path } : {});
      },
      createFolder: async (connectionId, path, name) => {
        const remote = clients.get(connectionId);
        if (!remote) throw new Error("Remote device is not configured");
        return remote.call("directories.create", { path, name });
      },
      serverStart: (options) => local.remote.serverStart(options),
      serverStop: () => local.remote.serverStop(),
      serverAutoStart: (enabled) => local.remote.serverAutoStart(enabled),
      serverStatus: () => local.remote.serverStatus(),
    },
  };
}

/** Entire Swath API backed by the connector serving the web application. */
export function createRemoteWebSwath(): SwathApi {
  const id = "host";
  const client = new RemoteClient({ id, url: location.origin, token: "" });
  const noServer = async (): Promise<RemoteServerStatus> => ({
    running: true,
    startOnLaunch: false,
    machineId: id,
    platform: "web",
  });
  return {
    platform: "web",
    config: {
      load: () => client.call("config.load"),
      snapshot: () => client.call("config.snapshot"),
      commit: (request) => client.call("config.commit", request),
      onChanged: (callback) => {
        const offEvent = client.onEvent((event) => {
          if (event.channel === "config:changed") callback(event.payload as { revision: number });
        });
        const offStatus = client.onStatus((status) => {
          if (status === "connected") callback({ revision: Number.MAX_SAFE_INTEGER });
        });
        return () => {
          offEvent();
          offStatus();
        };
      },
      save: (config) => client.call("config.save", { config }),
    },
    dialog: {
      selectFolder: async () => ({ canceled: true, path: null, name: null }),
      confirm: async (r) => window.confirm(r.detail ? `${r.message}\n\n${r.detail}` : r.message),
    },
    clipboard: {
      readForTerminal: readBrowserClipboard,
      writeText: (text) => navigator.clipboard.writeText(text),
    },
    browser: {
      openExternal: async (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    permissions: { ensureTerminalPaste: async () => ({ accessibility: "unavailable" }) },
    terminal: {
      create: (r) => client.call("terminal.create", r),
      write: (sessionId, data) => client.call("terminal.write", { sessionId, data }),
      resize: (r) => void client.call("terminal.resize", r).catch(() => undefined),
      kill: (sessionId) => void client.call("terminal.kill", { sessionId }).catch(() => undefined),
      attach: (r) => client.call("terminal.attach", r),
      restart: (sessionId) => client.call("terminal.restart", { sessionId }),
      replay: async (sessionId) => {
        const { data, ...status } = await client.call<{
          data: string;
          sessionId: string;
          running: boolean;
        }>("terminal.replay", { sessionId });
        client.deliverReplay(sessionId, data);
        return status;
      },
      setStreaming: (sessionId, enabled) =>
        void client.call("terminal.setStreaming", { sessionId, enabled }).catch(() => undefined),
      isBusy: (sessionId) => client.call("terminal.isBusy", { sessionId }),
      onData: (cb) =>
        client.onEvent((e) => {
          if (e.channel === "terminal:data") {
            const p = e.payload as any;
            cb(p.sessionId, p.data);
          }
        }),
      onExit: (cb) =>
        client.onEvent((e) => {
          if (e.channel === "terminal:exit") {
            const p = e.payload as any;
            cb(p.sessionId, p);
          }
        }),
    },
    app: { onCommand: () => () => undefined },
    git: {
      rpc: (r) => client.call("git.rpc", r),
      onData: (cb) =>
        client.onEvent((e) => {
          if (e.channel === "git:data") {
            const p = e.payload as any;
            cb(p.runId, p.data);
          }
        }),
    },
    askImages: { load: (r) => client.call("askImages.load", r) },
    files: { rpc: (r) => client.call("files.rpc", r) },
    pi: {
      rpc: (r) => client.call("pi.rpc", r),
      onEvent: (cb) =>
        client.onEvent((e) => {
          if (e.channel === "pi:event") {
            const p = e.payload as any;
            cb(p.paneId, p.line, p.exit === true);
          }
        }),
    },
    remote: {
      connect: async () => {
        throw new Error("Already connected to this host");
      },
      forget: () => undefined,
      status: () => client.status,
      onStatus: (cb) => client.onStatus((s) => cb(id, s)),
      listFolders: (_connectionId, path) => client.call("directories.list", path ? { path } : {}),
      createFolder: (_connectionId, path, name) =>
        client.call("directories.create", { path, name }),
      serverStart: noServer,
      serverStop: async () => undefined,
      serverAutoStart: noServer,
      serverStatus: noServer,
    },
  };
}
