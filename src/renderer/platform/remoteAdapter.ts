import type { SwathApi, RemoteHandshake, RemoteServerStatus } from "../../shared/ipc/swath";
import type { RemoteConnection } from "../../shared/types";
import type { RemoteEvent, RemoteMethod, RemoteResponse } from "../../shared/ipc/remote";
import { parseRemotePath } from "../../shared/ipc/remote";
import { browserLocalState, loadBrowserEventCursor, saveBrowserEventCursor } from "./localState";

type Status = "connected" | "connecting" | "offline";
type EventChannel = RemoteEvent["channel"];

/** A remote call must not leave a pane waiting forever for a lost response. */
export const REMOTE_RPC_TIMEOUT_MS = 30_000;
const REMOTE_SOCKET_OPEN_TIMEOUT_MS = 10_000;

export class RemoteRpcError extends Error {
  constructor(
    message: string,
    readonly codes: string[],
    readonly detail: unknown,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RemoteRpcError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function remoteTransportError(
  code: string,
  message: string,
  detail: unknown,
  retryable = true,
): RemoteRpcError {
  return new RemoteRpcError(message, [code], detail, retryable);
}

/** Converts nested connector/executor/catalog envelopes into one actionable client error. */
export function remoteRpcError(raw: unknown): RemoteRpcError {
  let detail: unknown = raw;
  if (raw instanceof Error) {
    return remoteTransportError("remote_error", raw.message, raw, true);
  }
  if (typeof raw === "string") {
    try {
      detail = JSON.parse(raw);
    } catch {
      return new RemoteRpcError(raw, [], raw, false);
    }
  }
  const codes: string[] = [];
  let message: string | null = null;
  let retryable = false;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (!message) message = value;
      try {
        visit(JSON.parse(value));
      } catch {
        // Plain error text is already retained above.
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string" && !codes.includes(record.code)) codes.push(record.code);
    if (record.retryable === true) retryable = true;
    if (typeof record.message === "string") message = record.message;
    if (record.error !== undefined) visit(record.error);
  };
  visit(detail);
  const summary =
    [codes.join(" → "), message].filter(Boolean).join(": ") || "Remote request failed";
  return new RemoteRpcError(summary, codes, detail, retryable);
}

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
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
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
      const socket = this.socket;
      try {
        await this.waitForOpen(socket);
      } catch (error) {
        throw this.connectionError(error);
      }
      return;
    }
    this.setStatus("connecting");
    if (!this.cursorLoaded) {
      try {
        this.durableCursor = await loadBrowserEventCursor(this.connection.id);
        this.cursorLoaded = true;
      } catch (error) {
        this.setStatus("offline");
        throw this.connectionError(error);
      }
    }
    const protocols = this.connection.token
      ? ["swath-v2", authProtocol(this.connection.token)]
      : ["swath-v2"];
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl(this.connection.url), protocols);
    } catch (error) {
      this.setStatus("offline");
      throw this.connectionError(error);
    }
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.closed(socket));
    try {
      await this.waitForOpen(socket);
      this.setStatus("connected");
      void this.restoreEventSubscription();
    } catch (error) {
      // A failed WebSocket can remain in CONNECTING for a short time. Clear our
      // reference immediately so subsequent calls do not wait on a dead socket.
      const wasCurrentSocket = this.socket === socket;
      if (wasCurrentSocket) {
        this.socket = null;
        this.setStatus("offline");
        this.scheduleReconnect();
      }
      try {
        socket.close();
      } catch {
        // The browser may throw when closing a socket that failed to construct.
      }
      throw this.connectionError(error);
    }
  }

  private waitForOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (socket.readyState !== WebSocket.CONNECTING) {
      return Promise.reject(new Error("Remote socket is not connecting"));
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        finish(
          remoteTransportError(
            "remote_connect_timeout",
            `Timed out connecting to ${this.connection.url}`,
            { url: this.connection.url, timeoutMs: REMOTE_SOCKET_OPEN_TIMEOUT_MS },
          ),
        );
      }, REMOTE_SOCKET_OPEN_TIMEOUT_MS);

      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      const finish = (error?: Error) => {
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = () =>
        finish(
          remoteTransportError(
            "remote_connect_failed",
            `Could not connect to ${this.connection.url}`,
            { url: this.connection.url },
          ),
        );
      const onClose = () =>
        finish(
          remoteTransportError(
            "remote_disconnected",
            `Remote connection to ${this.connection.url} closed before it opened`,
            { url: this.connection.url },
          ),
        );
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });
  }

  private connectionError(error: unknown): RemoteRpcError {
    if (error instanceof RemoteRpcError) return error;
    return remoteTransportError(
      "remote_connect_failed",
      `Could not connect to ${this.connection.url}: ${errorMessage(error)}`,
      { url: this.connection.url, cause: error },
    );
  }

  close(): void {
    if (this.retry !== null) window.clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    this.setStatus("offline");
    if (socket) {
      try {
        socket.close();
      } catch {
        // Closing an already-failed socket is best effort.
      }
    }
    this.rejectPending(
      remoteTransportError(
        "remote_closed",
        "Remote connection closed",
        {
          url: this.connection.url,
        },
        false,
      ),
    );
  }

  private closed(socket: WebSocket): void {
    // Ignore close events from an old socket after a reconnect or explicit close.
    if (this.socket !== socket) return;
    this.socket = null;
    this.setStatus("offline");
    this.rejectPending(
      remoteTransportError("remote_disconnected", "Remote device disconnected", {
        url: this.connection.url,
      }),
    );
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.eventListeners.size === 0 || this.retry !== null) return;
    this.retry = window.setTimeout(() => {
      this.retry = null;
      void this.open().catch(() => undefined);
    }, 2_000);
  }

  private rejectPending(error: RemoteRpcError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
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
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(remoteRpcError(message.error));
    else pending.resolve(message.result);
  }

  async call<T>(method: RemoteMethod, params?: unknown): Promise<T> {
    try {
      await this.open();
    } catch (error) {
      // Keep call failures actionable and make sure a future call can retry on a
      // fresh socket after a failed open.
      throw error instanceof RemoteRpcError
        ? error
        : remoteTransportError(
            "remote_connect_failed",
            `Could not connect to ${this.connection.url} for ${method}: ${errorMessage(error)}`,
            { method, url: this.connection.url, cause: error },
          );
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw remoteTransportError(
        "remote_not_connected",
        `Remote connection is not open for ${method}`,
        { method, url: this.connection.url },
      );
    }
    const id = `${this.clientId}:${this.nextId++}`;
    let payload: string;
    try {
      payload = JSON.stringify({ type: "request", id, method, params });
    } catch (error) {
      throw remoteTransportError(
        "remote_encode_failed",
        `Could not encode remote request ${method}: ${errorMessage(error)}`,
        { method, url: this.connection.url, cause: error },
        false,
      );
    }
    return await new Promise<T>((resolve, reject) => {
      const pending = {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeout: setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this.pending.delete(id);
          reject(
            remoteTransportError(
              "rpc_timeout",
              `Remote request timed out after ${REMOTE_RPC_TIMEOUT_MS}ms: ${method}`,
              { method, url: this.connection.url, timeoutMs: REMOTE_RPC_TIMEOUT_MS },
            ),
          );
        }, REMOTE_RPC_TIMEOUT_MS),
      };
      this.pending.set(id, pending);
      try {
        socket.send(payload);
      } catch (error) {
        if (this.pending.get(id) === pending) {
          this.pending.delete(id);
          clearTimeout(pending.timeout);
        }
        reject(
          remoteTransportError(
            "remote_send_failed",
            `Could not send remote request ${method}: ${errorMessage(error)}`,
            { method, url: this.connection.url, cause: error },
          ),
        );
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
