/**
 * Renderer → host file-tree requests. Every `path` is `/`-separated and relative
 * to `cwd`; the empty string is the workspace root.
 */
export type FilesExecutionTarget = {
  taskId?: string;
  executionGeneration?: number;
  paneId?: string;
};
export type FilesRpcRequest =
  | (FilesExecutionTarget & { op: "list"; cwd: string; path: string })
  | (FilesExecutionTarget & { op: "readText"; cwd: string; path: string })
  | (FilesExecutionTarget & { op: "rename"; cwd: string; from: string; to: string })
  | (FilesExecutionTarget & { op: "trash"; cwd: string; path: string });

/** One directory entry as returned by `list`. */
export interface FilesEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Successful `list` payload for a single directory level. */
export interface FilesListSuccess {
  ok: true;
  path: string;
  entries: FilesEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/** Validates renderer → main files payloads. */
export function parseFilesRpcRequest(raw: unknown): FilesRpcRequest | null {
  if (!isRecord(raw)) return null;
  const cwd = stringField(raw, "cwd")?.trim();
  if (!cwd) return null;
  const taskId = stringField(raw, "taskId")?.trim();
  const paneId = stringField(raw, "paneId")?.trim();
  const executionGeneration = raw.executionGeneration;
  const target: FilesExecutionTarget = {
    ...(taskId ? { taskId } : {}),
    ...(paneId ? { paneId } : {}),
    ...(typeof executionGeneration === "number" && Number.isInteger(executionGeneration)
      ? { executionGeneration }
      : {}),
  };
  if (raw.op === "list" || raw.op === "readText" || raw.op === "trash") {
    const path = stringField(raw, "path");
    if (path === null) return null;
    return { op: raw.op, cwd, path: path.trim(), ...target };
  }
  if (raw.op === "rename") {
    const from = stringField(raw, "from")?.trim();
    const to = stringField(raw, "to")?.trim();
    if (!from || !to) return null;
    return { op: "rename", cwd, from, to, ...target };
  }
  return null;
}

/** Parses a successful directory listing; returns null when shape is invalid. */
export function parseFilesListSuccess(raw: unknown): FilesListSuccess | null {
  if (!isRecord(raw) || raw.ok !== true) return null;
  const path = stringField(raw, "path");
  if (path === null || !Array.isArray(raw.entries)) return null;
  const entries: FilesEntry[] = [];
  for (const item of raw.entries) {
    if (!isRecord(item)) return null;
    const name = stringField(item, "name");
    const entryPath = stringField(item, "path");
    if (name === null || entryPath === null || typeof item.isDir !== "boolean") return null;
    entries.push({ name, path: entryPath, isDir: item.isDir });
  }
  return { ok: true, path, entries };
}
