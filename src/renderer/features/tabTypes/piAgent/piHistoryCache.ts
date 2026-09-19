import type { SyncReply } from "../../../../shared/ipc/swath";
import type { PiIncoming } from "../../../../shared/ipc/piRpc";

/** Durable transcript state; drafts deliberately do not live here. */
export type PiHistoryStatus = "local" | "pending" | "synced" | "unavailable";
export interface PiHistoryScope {
  networkId: string;
  taskId: string;
  paneId: string;
  sessionId: string;
  executionGeneration: number;
}

export interface CachedPiHistory extends PiHistoryScope {
  /** Opaque backend cursor; never infer ordering from it. */
  cursor: string | null;
  records: Array<{ id: string; sequence: number; event: PiIncoming }>;
  status: PiHistoryStatus;
}

const DB = "swath-pi-history";
const STORE = "history";
const memory = new Map<string, CachedPiHistory>();
const key = (scope: PiHistoryScope) =>
  `${scope.networkId}:${scope.taskId}:${scope.paneId}:${scope.sessionId}:${scope.executionGeneration}`;

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Loads cached history; this never asks the executor to spawn. */
export async function loadPiHistory(scope: PiHistoryScope): Promise<CachedPiHistory | null> {
  const local = memory.get(key(scope));
  if (local) return structuredClone(local);
  const db = await database();
  if (!db) return null;
  return await new Promise((resolve) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key(scope));
    request.onsuccess = () => resolve((request.result as CachedPiHistory | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

export async function savePiHistory(history: CachedPiHistory): Promise<void> {
  const copy = structuredClone(history);
  memory.set(key(copy), copy);
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(copy, key(copy));
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

/** Applies only this pane's immutable records; duplicated reconnect deliveries are harmless. */
export function applyPiHistory(
  current: CachedPiHistory | null,
  reply: SyncReply,
  scope: PiHistoryScope,
): CachedPiHistory {
  if (reply.code === "cursor_expired")
    return { ...scope, cursor: null, records: [], status: "unavailable" };
  const existing = new Map((current?.records ?? []).map((record) => [record.id, record]));
  for (const record of reply.records) {
    if (
      record.taskId !== scope.taskId ||
      record.paneId !== scope.paneId ||
      record.executionGeneration !== scope.executionGeneration
    )
      continue;
    existing.set(record.stableId, {
      id: record.stableId,
      sequence: record.sequence,
      event: record.event,
    });
  }
  return {
    ...scope,
    networkId: reply.networkId,
    cursor: reply.cursor,
    records: [...existing.values()].sort((a, b) => a.sequence - b.sequence),
    status: "synced",
  };
}
