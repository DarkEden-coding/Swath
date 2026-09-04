import type { SwathApi, RemoteHandshake, RemoteServerStatus } from "../../shared/ipc/swath";
import type { RemoteConnection } from "../../shared/types";
import type { RemoteEvent, RemoteMethod, RemoteResponse } from "../../shared/ipc/remote";
import { parseRemotePath } from "../../shared/ipc/remote";

type Status = "connected" | "connecting" | "offline";
type EventChannel = RemoteEvent["channel"];

function normalizeUrl(value: string): string {
  const url = new URL(value.includes("://") ? value : `http://${value}`);
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
  private pending = new Map<
    number,
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
    const protocols = this.connection.token
      ? ["swath-v1", authProtocol(this.connection.token)]
      : ["swath-v1"];
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
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  async call<T>(method: RemoteMethod, params?: unknown): Promise<T> {
    await this.open();
    const id = this.nextId++;
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
      create: async (request) => {
        const remote = remoteFor(request.cwd);
        if (!remote) return local.terminal.create(request);
        terminalOwners.set(request.sessionId, remote.connection.id);
        await remote.call("terminal.create", unroute(request));
      },
      write: async (sessionId, data) => {
        const remote = clients.get(terminalOwners.get(sessionId) ?? "");
        return remote
          ? void (await remote.call("terminal.write", { sessionId, data }))
          : local.terminal.write(sessionId, data);
      },
      resize: (request) => {
        const remote = clients.get(terminalOwners.get(request.sessionId) ?? "");
        remote ? void remote.call("terminal.resize", request) : local.terminal.resize(request);
      },
      kill: (sessionId) => {
        const remote = clients.get(terminalOwners.get(sessionId) ?? "");
        remote ? void remote.call("terminal.kill", { sessionId }) : local.terminal.kill(sessionId);
        terminalOwners.delete(sessionId);
      },
      attach: async (request) => {
        const remote = remoteFor(request.cwd);
        if (!remote) return local.terminal.attach(request);
        terminalOwners.set(request.sessionId, remote.connection.id);
        return remote.call("terminal.attach", unroute(request));
      },
      restart: async (sessionId) =>
        clients.get(terminalOwners.get(sessionId) ?? "")?.call("terminal.restart", { sessionId }) ??
        local.terminal.restart(sessionId),
      replay: async (sessionId) =>
        clients.get(terminalOwners.get(sessionId) ?? "")?.call("terminal.replay", { sessionId }) ??
        local.terminal.replay(sessionId),
      setStreaming: (sessionId, enabled) => {
        const remote = clients.get(terminalOwners.get(sessionId) ?? "");
        remote
          ? void remote.call("terminal.setStreaming", { sessionId, enabled })
          : local.terminal.setStreaming(sessionId, enabled);
      },
      isBusy: async (sessionId) =>
        clients.get(terminalOwners.get(sessionId) ?? "")?.call("terminal.isBusy", { sessionId }) ??
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
      serverStart: noServer,
      serverStop: async () => undefined,
      serverStatus: noServer,
    },
  });
  // The hybrid wrapper needs a profile when routing virtual paths, but direct web calls are local
  // to its remote host, so returning the base implementation is both simpler and faster.
  return api;
}
