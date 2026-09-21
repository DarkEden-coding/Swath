import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogReplyError, reorderTaskPanes } from "./catalogMutations";
import { useTaskStore } from "../../state/taskStore";

afterEach(() => {
  useTaskStore.setState(useTaskStore.getInitialState(), true);
});

describe("catalogReplyError", () => {
  it("handles structured, encoded, and thrown host failures", () => {
    expect(catalogReplyError({ ok: false, code: "revision_conflict", error: "Refresh" })).toBe(
      "revision_conflict: Refresh",
    );
    expect(catalogReplyError('{"ok":false,"code":"offline","message":"Unavailable"}')).toBe(
      "offline: Unavailable",
    );
    expect(catalogReplyError(new Error("connection closed"))).toBe("connection closed");
    expect(catalogReplyError({ ok: true })).toBeNull();
  });

  it("retries an ambiguous write with the same operation id", async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValueOnce({ ok: true });
    globalThis.window = {
      swath: {
        tasks: { rpc },
      },
    } as unknown as Window & typeof globalThis;
    useTaskStore.setState({
      catalog: {
        projects: [],
        tasks: [
          {
            id: "task",
            projectId: "project",
            title: "Task",
            assignedDeviceId: "device",
            executionGeneration: 1,
            lifecycle: "active",
            paneOrder: ["a", "b"],
            revision: 1,
            createdAt: 0,
          },
        ],
        panes: [],
      },
      refresh: vi.fn(async () => undefined),
    });

    reorderTaskPanes("task", ["b", "a"]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[0].operationId).toBe(rpc.mock.calls[1]?.[0].operationId);
  });
});
