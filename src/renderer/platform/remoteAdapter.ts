import type { SwathApi, RemoteHandshake, RemoteServerStatus } from "../../shared/ipc/swath";
import type { RemoteConnection } from "../../shared/types";
import type { RemoteEvent, RemoteMethod, RemoteResponse } from "../../shared/ipc/remote";
import { parseRemotePath } from "../../shared/ipc/remote";
import { browserLocalState, loadBrowserEventCursor, saveBrowserEventCursor } from "./localState";

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
  private readonly clientId = crypto.randomUUID();
  private nextId = 1;
  private retry: number | null = null;
  // The gateway retains task events; reconnecting never relies on renderer ownership maps.
  private durableCursor = 0;
  private cursorLoaded = false;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
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
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.socket?.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve, reject) => {
        const socket = this.socket!;
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Remote connection failed")), {
          once: true,
        });
      });
      return;
    }
    this.setStatus("connecting");
    if (!this.cursorLoaded) {
      this.durableCursor = await loadBrowserEventCursor(this.connection.id);
      this.cursorLoaded = true;
    }
    const protocols = this.connection.token
      ? ["swath-v2", authProtocol(this.connection.token)]
      : ["swath-v2"];
    const socket = new WebSocket(socketUrl(this.connection.url), protocols);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.closed());
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener(
        "open",
        () => {
          this.setStatus("connected");
          resolve();
          void this.restoreEventSubscription();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => reject(new Error(`Could not connect to ${this.connection.url}`)),
        { once: true },
      );
    });
  }

  close(): void {
    if (this.retry !== null) window.clearTimeout(this.retry);
    this.retry = null;
    this.socket?.close();
    this.socket = null;
    this.setStatus("offline");
  }

  private closed(): void {
    this.socket = null;
    this.setStatus("offline");
    for (const pending of this.pending.values())
      pending.reject(new Error("Remote device disconnected"));
    this.pending.clear();
    if (this.eventListeners.size > 0 && this.retry === null) {
      this.retry = window.setTimeout(() => {
        this.retry = null;
        void this.open().catch(() => undefined);
      }, 2_000);
    }
  }

  private async restoreEventSubscription(): Promise<void> {
    try {
      const replay = await this.call<{
        status: "replayed" | "cursor_expired";
        attachments?: Array<Record<string, unknown>>;
      }>("event.subscribe", { cursor: this.durableCursor });
      if (replay.status === "cursor_expired") {
        this.durableCursor = 0;
        await saveBrowserEventCursor(this.connection.id, 0);
        await this.call("event.subscribe", { cursor: null, attachments: replay.attachments ?? [] });
      }
    } catch {
      // The socket reconnect loop retries the durable subscription.
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
      if (typeof message.cursor === "number" && message.cursor > this.durableCursor) {
        this.durableCursor = message.cursor;
        void saveBrowserEventCursor(this.connection.id, message.cursor);
        // Ack is monotonic and idempotent; a lost ack only causes a safe replay.
        void this.call("event.ack", { clientId: this.clientId, cursor: message.cursor }).catch(
          () => undefined,
        );
      }
      this.eventListeners.forEach((listener) => listener(message));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  async call<T>(method: RemoteMethod, params?: unknown): Promise<T> {
    await this.open();
    const id = `${this.clientId}:${this.nextId++}`;
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket!.send(JSON.stringify({ type: "request", id, method, params }));
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

function taskScoped(value: unknown): boolean {
  return !!value && typeof value === "object" && "taskId" in value;
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

  const originalLoad = local.config.load;
  local.config.load = async () => {
    const config = await originalLoad();
    for (const profile of config.remoteConnections ?? []) {
      const remote = client(profile);
      void remote.open().catch(() => undefined);
    }
    return config;
  };

  return {
    ...local,
    config: local.config,
    terminal: {
      // The connector resolves task ownership from the durable catalog. Renderer caches are
      // deliberately not authority: they disappear on refresh and can become stale on transfer.
      create: (request) => local.terminal.create(request),
      write: (sessionId, data) => local.terminal.write(sessionId, data),
      resize: (request) => local.terminal.resize(request),
      kill: (sessionId) => local.terminal.kill(sessionId),
      attach: (request) => local.terminal.attach(request),
      restart: (sessionId) => local.terminal.restart(sessionId),
      replay: (sessionId) => local.terminal.replay(sessionId),
      setStreaming: (sessionId, enabled) => local.terminal.setStreaming(sessionId, enabled),
      isBusy: (sessionId) => local.terminal.isBusy(sessionId),
      onData: event("terminal:data", local.terminal.onData, (p) => [p.sessionId, p.data]),
      onExit: event("terminal:exit", local.terminal.onExit, (p) => [
        p.sessionId,
        { exitCode: p.exitCode, signal: p.signal },
      ]),
    },
    git: {
      rpc: async (request) => {
        if (taskScoped(request)) return local.git.rpc(request);
        return remoteFor(request)?.call("git.rpc", unroute(request)) ?? local.git.rpc(request);
      },
      onData: event("git:data", local.git.onData, (p) => [p.runId, p.data]),
    },
    files: {
      rpc: async (request) => {
        if (taskScoped(request)) return local.files.rpc(request);
        return remoteFor(request)?.call("files.rpc", unroute(request)) ?? local.files.rpc(request);
      },
    },
    askImages: {
      load: async (request) =>
        taskScoped(request)
          ? local.askImages.load(request)
          : (remoteFor(request)?.call("askImages.load", unroute(request)) ??
            local.askImages.load(request)),
    },
    tasks: { rpc: (request) => local.tasks.rpc(request) },
    pi: {
      rpc: (request) => local.pi.rpc(request),
      onEvent: event("pi:event", local.pi.onEvent, (p) => [p.paneId, p.line, p.exit === true]),
    },
    sync: local.sync,
    network: local.network,
    catalog: local.catalog,
    // A native installation always migrates its own local legacy database. Configured remote
    // connections are available for task routing, but must not capture startup migration calls.
    migration: local.migration,
    remote: {
      connect: async (url, token) => {
        const normalized = normalizeUrl(url);
        const response = await fetch(new URL("/api/handshake", normalized), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "Connector authentication failed"
              : `Connector returned ${response.status}`,
          );
        const handshake = (await response.json()) as RemoteHandshake;
        if (handshake.protocol !== 2)
          throw new Error(
            `Incompatible remote protocol ${handshake.protocol}; this client requires v2`,
          );
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
      serverStart: (options) => local.remote.serverStart(options),
      serverStop: () => local.remote.serverStop(),
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
    machineId: id,
    platform: "web",
  });
  const api = createHybridSwath({
    platform: "web",
    config: {
      load: () => client.call("config.load"),
      save: (config) => client.call("config.save", { config }),
    },
    dialog: {
      selectFolder: async () => ({ canceled: true, path: null, name: null }),
      confirm: async (r) => window.confirm(r.detail ? `${r.message}\n\n${r.detail}` : r.message),
    },
    clipboard: {
      readForTerminal: async () => ({
        text: await navigator.clipboard.readText(),
        hasImage: false,
      }),
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
      resize: (r) => void client.call("terminal.resize", r),
      kill: (sessionId) => void client.call("terminal.kill", { sessionId }),
      attach: (r) => client.call("terminal.attach", r),
      restart: (sessionId) => client.call("terminal.restart", { sessionId }),
      replay: (sessionId) => client.call("terminal.replay", { sessionId }),
      setStreaming: (sessionId, enabled) =>
        void client.call("terminal.setStreaming", { sessionId, enabled }),
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
    tasks: { rpc: (r) => client.call("task.rpc", r) },
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
    sync: {
      snapshot: (networkId) => client.call("sync.snapshot", { networkId }),
      changes: (networkId, cursor) => client.call("sync.changes", { networkId, cursor }),
      ack: (networkId, cursor) => client.call("sync.ack", { networkId, cursor }),
      conflicts: (networkId) => client.call("sync.conflicts", { networkId }),
    },
    network: {
      current: () => client.call("network.current"),
      initialize: (name) => client.call("network.initialize", { name }),
      discover: () => client.call("network.discover"),
      requestJoin: (networkId, endpoint, enrollmentSecret) =>
        client.call("network.requestJoin", { networkId, endpoint, enrollmentSecret }),
      joinStatus: (enrollmentId) => client.call("network.joinStatus", { enrollmentId }),
      approveJoin: (networkId, enrollmentId) =>
        client.call("network.approveJoin", { networkId, enrollmentId }),
      membership: (networkId) => client.call("network.membership", { networkId }),
      promote: (networkId, deviceId) => client.call("network.promote", { networkId, deviceId }),
      demote: (networkId, deviceId) => client.call("network.demote", { networkId, deviceId }),
      health: (networkId) => client.call("network.health", { networkId }),
    },
    catalog: {
      snapshot: (networkId) => client.call("catalog.snapshot", { networkId }),
      mutate: (request) => client.call("catalog.mutate", request),
    },
    migration: {
      status: () => client.call("migration.status"),
      preview: (operationId) => client.call("migration.preview", { operationId }),
      confirm: (request) => client.call("migration.confirm", { request }),
      export: () => client.call("migration.export"),
      conflicts: () => client.call("migration.conflicts"),
      submitProposal: (proposal) => client.call("migration.submitProposal", { proposal }),
      approveProposal: (approval) => client.call("migration.approveProposal", { approval }),
    },
    localState: browserLocalState(id),
    remote: {
      connect: async () => {
        throw new Error("Already connected to this host");
      },
      forget: () => undefined,
      status: () => client.status,
      onStatus: (cb) => client.onStatus((s) => cb(id, s)),
      listFolders: (_connectionId, path) => client.call("directories.list", path ? { path } : {}),
      serverStart: noServer,
      serverStop: async () => undefined,
      serverStatus: noServer,
    },
  });
  // The hybrid wrapper needs a profile when routing virtual paths, but direct web calls are local
  // to its remote host, so returning the base implementation is both simpler and faster.
  return api;
}
