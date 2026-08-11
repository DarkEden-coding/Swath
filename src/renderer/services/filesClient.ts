import type { FilesEntry, FilesRpcRequest } from "../../shared/ipc";
import { parseFilesListSuccess } from "../../shared/ipc";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Invokes the host files RPC surface. */
async function filesRpc(request: FilesRpcRequest): Promise<unknown> {
  return window.swath.files.rpc(request);
}

/** Extracts the host's error text, falling back to `fallback`. */
function errorFrom(raw: unknown, fallback: string): Error {
  const message = isRecord(raw) && typeof raw.error === "string" ? raw.error.trim() : "";
  return new Error(message || fallback);
}

/** Lists one directory level under `cwd`; `path` is relative, empty for the root. */
export async function listDir(cwd: string, path: string): Promise<FilesEntry[]> {
  const raw = await filesRpc({ op: "list", cwd, path });
  const success = parseFilesListSuccess(raw);
  if (!success) throw errorFrom(raw, "Unable to read directory");
  return success.entries;
}

/** Reads a UTF-8 text file relative to `cwd`. */
export async function readTextFile(cwd: string, path: string): Promise<string> {
  const raw = await filesRpc({ op: "readText", cwd, path });
  if (!isRecord(raw) || raw.ok !== true || typeof raw.text !== "string") {
    throw errorFrom(raw, "Unable to read file");
  }
  return raw.text;
}

/** Moves or renames an entry; both paths are relative to `cwd`. */
export async function renameEntry(cwd: string, from: string, to: string): Promise<void> {
  const raw = await filesRpc({ op: "rename", cwd, from, to });
  if (!isRecord(raw) || raw.ok !== true) throw errorFrom(raw, "Unable to move");
}

/** Sends an entry to the OS trash. */
export async function trashEntry(cwd: string, path: string): Promise<void> {
  const raw = await filesRpc({ op: "trash", cwd, path });
  if (!isRecord(raw) || raw.ok !== true) throw errorFrom(raw, "Unable to move to trash");
}

export const filesClient = {
  list: listDir,
  readText: readTextFile,
  rename: renameEntry,
  trash: trashEntry,
};
