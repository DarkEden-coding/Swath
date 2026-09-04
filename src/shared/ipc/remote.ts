export const REMOTE_PROTOCOL_VERSION = 1 as const;

export type RemoteMethod =
  | "config.load"
  | "config.save"
  | "terminal.create"
  | "terminal.write"
  | "terminal.resize"
  | "terminal.kill"
  | "terminal.attach"
  | "terminal.restart"
  | "terminal.replay"
  | "terminal.setStreaming"
  | "terminal.isBusy"
  | "git.rpc"
  | "files.rpc"
  | "askImages.load"
  | "pi.rpc"
  | "directories.list";

export interface RemoteRequest {
  type: "request";
  id: number;
  method: RemoteMethod;
  params?: unknown;
}

export interface RemoteResponse {
  type: "response";
  id: number;
  result?: unknown;
  error?: string;
}

export interface RemoteEvent {
  type: "event";
  channel: "terminal:data" | "terminal:exit" | "git:data" | "pi:event";
  payload: unknown;
}

export type RemoteMessage = RemoteRequest | RemoteResponse | RemoteEvent;

const PREFIX = "swath-remote://";

/** Encodes ownership into a path so routing is deterministic even when two machines share paths. */
export function toRemotePath(connectionId: string, path: string): string {
  return `${PREFIX}${encodeURIComponent(connectionId)}/${encodeURIComponent(path)}`;
}

export function parseRemotePath(path: string): { connectionId: string; path: string } | null {
  if (!path.startsWith(PREFIX)) return null;
  const slash = path.indexOf("/", PREFIX.length);
  if (slash < 0) return null;
  try {
    return {
      connectionId: decodeURIComponent(path.slice(PREFIX.length, slash)),
      path: decodeURIComponent(path.slice(slash + 1)),
    };
  } catch {
    return null;
  }
}

export function displayWorkspacePath(path: string): string {
  return parseRemotePath(path)?.path ?? path;
}

function looksAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/** Rewrites paths and ids from a remote config into a collision-proof local namespace. */
export function importRemoteValue<T>(connectionId: string, value: T, key = ""): T {
  if (typeof value === "string") {
    if (looksAbsolutePath(value)) return toRemotePath(connectionId, value) as T;
    if (key === "id" || key.endsWith("Id")) return `${connectionId}:${value}` as T;
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => importRemoteValue(connectionId, item, key)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        importRemoteValue(connectionId, child, childKey),
      ]),
    ) as T;
  }
  return value;
}
