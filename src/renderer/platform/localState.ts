import type { TaskInterfaceState } from "../domain/tasks/taskActions";

const DB = "swath-interface-state";
const STORE = "state";
const key = (networkId: string, interfaceId: string) => `${networkId}:${interfaceId}`;
const cursorKey = (connectionId: string) => `cursor:${connectionId}`;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Browser event cursors are sensitive local cache state, so use the same IndexedDB store as layouts. */
export async function loadBrowserEventCursor(connectionId: string): Promise<number> {
  const db = await open();
  if (!db) return 0;
  return await new Promise((resolve) => {
    const request = db.transaction(STORE).objectStore(STORE).get(cursorKey(connectionId));
    request.onsuccess = () => resolve(Number(request.result?.cursor) || 0);
    request.onerror = () => resolve(0);
  });
}

export async function saveBrowserEventCursor(connectionId: string, cursor: number): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const request = db
      .transaction(STORE, "readwrite")
      .objectStore(STORE)
      .put({ cursor }, cursorKey(connectionId));
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

export function browserLocalState(interfaceId = "default") {
  return {
    load: async (
      networkId: string,
    ): Promise<{ revision: number; state: TaskInterfaceState } | null> => {
      const db = await open();
      if (!db) return null;
      return await new Promise((resolve) => {
        const request = db.transaction(STORE).objectStore(STORE).get(key(networkId, interfaceId));
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
      });
    },
    save: async (
      networkId: string,
      state: TaskInterfaceState,
      revision: number,
    ): Promise<number> => {
      const db = await open();
      if (!db) return revision;
      return await new Promise((resolve) => {
        const request = db
          .transaction(STORE, "readwrite")
          .objectStore(STORE)
          .put({ revision, state: structuredClone(state) }, key(networkId, interfaceId));
        request.onsuccess = () => resolve(revision);
        request.onerror = () => resolve(revision);
      });
    },
  };
}
