import { describe, expect, it } from "vitest";
import { applyPiHistory, type PiHistoryScope } from "./piHistoryCache";

const scope: PiHistoryScope = {
  networkId: "network-a",
  taskId: "task",
  paneId: "pane",
  sessionId: "session",
  executionGeneration: 1,
};
const event = { type: "turn_end" } as const;
const record = (stableId: string, sequence: number) => ({
  taskId: scope.taskId,
  paneId: scope.paneId,
  executionGeneration: scope.executionGeneration,
  sessionId: scope.sessionId,
  sourceId: "source",
  stableId,
  sequence,
  event,
});

describe("pi history sync", () => {
  it("deduplicates reconnect records with opaque cursors", () => {
    const first = applyPiHistory(
      null,
      {
        status: "synced",
        networkId: "network-a",
        cursor: "pi-history-v1:1",
        records: [record("one", 1)],
      },
      scope,
    );
    const reconnect = applyPiHistory(
      first,
      {
        status: "synced",
        networkId: "network-a",
        cursor: "pi-history-v1:2",
        records: [record("one", 1), record("two", 2)],
      },
      scope,
    );
    expect(reconnect.records.map((item) => item.id)).toEqual(["one", "two"]);
    expect(reconnect.cursor).toBe("pi-history-v1:2");
  });

  it("resnapshot replaces an expired cursor without cross-pane records", () => {
    const expired = applyPiHistory(
      null,
      { code: "cursor_expired", networkId: "network-a", cursor: "pi-history-v1:2", records: [] },
      scope,
    );
    expect(expired.status).toBe("unavailable");
    const snapshot = applyPiHistory(
      null,
      {
        status: "synced",
        networkId: "network-a",
        cursor: "pi-history-v1:3",
        records: [record("one", 1), { ...record("other", 2), paneId: "other" }],
      },
      scope,
    );
    expect(snapshot.records.map((item) => item.id)).toEqual(["one"]);
  });

  it("does not mix records from another conversation in the same pane", () => {
    const snapshot = applyPiHistory(
      null,
      {
        status: "synced",
        networkId: "network-a",
        cursor: "pi-history-v1:2",
        records: [record("current", 1), { ...record("other-session", 2), sessionId: "other" }],
      },
      scope,
    );
    expect(snapshot.records.map((item) => item.id)).toEqual(["current"]);
  });

  it("retains the same conversation across executor generations", () => {
    const snapshot = applyPiHistory(
      null,
      {
        status: "synced",
        networkId: "network-a",
        cursor: "pi-history-v1:2",
        records: [
          record("current", 1),
          { ...record("before-transfer", 2), executionGeneration: 0 },
        ],
      },
      scope,
    );
    expect(snapshot.records.map((item) => item.id)).toEqual(["current", "before-transfer"]);
  });
});
