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

interface CachedPiHistoryCursor {
  kind: "network-cursor";
  networkId: string;
  cursor: string | null;
}

const DB = "swath-pi-history";
const STORE = "history";
const memory = new Map<string, CachedPiHistory>();
/** The sync cursor is an interface/network fact, not a pane fact. */
const networkCursors = new Map<string, string | null>();
const networkSyncs = new Map<string, Promise<void>>();
const key = (scope: PiHistoryScope) =>
  `${scope.networkId}:${scope.taskId}:${scope.paneId}:${scope.sessionId}:${scope.executionGeneration}`;
const cursorKey = (networkId: string) => `network-cursor:${networkId}`;

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

/**
 * Loads all locally cached records for a pane. A pane's persisted session file can change after
 * the first prompt, and records can span executor generations, so the cache lookup intentionally
 * does not use those fields as a partition boundary. `default` is the scope used before Pi has
 * reported its session identity and therefore matches every session for that pane.
 */
export async function loadPiHistoryForPane(scope: PiHistoryScope): Promise<CachedPiHistory | null> {
  const matches = (history: CachedPiHistory): boolean =>
    history.networkId === scope.networkId &&
    history.taskId === scope.taskId &&
    history.paneId === scope.paneId &&
    (scope.sessionId === "default" || history.sessionId === scope.sessionId);
  const histories = [...memory.values()].filter(matches);
  const db = await database();
  if (db) {
    const persisted = await new Promise<CachedPiHistory[]>((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as unknown[]).filter(
            (value): value is CachedPiHistory =>
              typeof value === "object" &&
              value !== null &&
              "records" in value &&
              matches(value as CachedPiHistory),
          ),
        );
      request.onerror = () => resolve([]);
    });
    for (const history of persisted) memory.set(key(history), structuredClone(history));
    histories.push(...persisted);
  }
  if (histories.length === 0) return null;
  const records = new Map<string, CachedPiHistory["records"][number]>();
  for (const history of histories)
    for (const record of history.records) records.set(record.id, record);
  const cursor = await loadNetworkCursor(scope.networkId);
  return {
    ...scope,
    cursor: cursor ?? histories.find((history) => history.cursor !== null)?.cursor ?? null,
    records: [...records.values()].sort((a, b) => a.sequence - b.sequence),
    status: histories.some((history) => history.status === "pending") ? "pending" : "local",
  };
}

async function loadNetworkCursor(networkId: string): Promise<string | null> {
  if (networkCursors.has(networkId)) return networkCursors.get(networkId) ?? null;
  const db = await database();
  if (!db) return null;
  const cursor = await new Promise<string | null>((resolve) => {
    const request = db.transaction(STORE).objectStore(STORE).get(cursorKey(networkId));
    request.onsuccess = () => {
      const value = request.result as CachedPiHistoryCursor | undefined;
      resolve(value?.kind === "network-cursor" ? value.cursor : null);
    };
    request.onerror = () => resolve(null);
  });
  networkCursors.set(networkId, cursor);
  return cursor;
}

async function saveNetworkCursor(networkId: string, cursor: string | null): Promise<void> {
  networkCursors.set(networkId, cursor);
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const request = db
      .transaction(STORE, "readwrite")
      .objectStore(STORE)
      .put(
        { kind: "network-cursor", networkId, cursor } satisfies CachedPiHistoryCursor,
        cursorKey(networkId),
      );
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
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

/**
 * Pulls one network change stream and fans every record into its pane cache. Calls made by
 * multiple mounted panes share this operation, so each pane cannot independently advance and
 * acknowledge a cursor that covers records belonging to its siblings.
 */
export async function syncPiHistory(scope: PiHistoryScope): Promise<void> {
  if (!scope.networkId) return;
  const existing = networkSyncs.get(scope.networkId);
  if (existing) {
    await existing;
    return;
  }
  const sync = (async () => {
    let reply = await window.swath.sync.changes(
      scope.networkId,
      await loadNetworkCursor(scope.networkId),
    );
    if (reply.code === "cursor_expired") reply = await window.swath.sync.snapshot(scope.networkId);
    const networkId = reply.networkId || scope.networkId;

    // Persist each record under its authoritative scope. This keeps records for unmounted panes
    // available when they are opened later, even though the network cursor has already advanced.
    for (const record of reply.records) {
      const recordScope: PiHistoryScope = {
        networkId,
        taskId: record.taskId,
        paneId: record.paneId,
        sessionId: record.sessionId,
        executionGeneration: record.executionGeneration,
      };
      const current = await loadPiHistory(recordScope);
      const next = applyPiHistory(current, { ...reply, records: [record] }, recordScope);
      await savePiHistory({ ...next, status: "pending" });
    }

    const ack = await window.swath.sync.ack(networkId, reply.cursor);
    if (!ack.ok) throw new Error("Pi history acknowledgement was rejected");
    // Advance the local interface cursor only after the shared acknowledgement succeeds. A
    // failed ack will replay immutable records on the next attempt, which is safe and lossless.
    await saveNetworkCursor(networkId, reply.cursor);
  })();
  networkSyncs.set(scope.networkId, sync);
  try {
    await sync;
  } finally {
    if (networkSyncs.get(scope.networkId) === sync) networkSyncs.delete(scope.networkId);
  }
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
      record.sessionId !== scope.sessionId
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
