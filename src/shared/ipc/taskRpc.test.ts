import { describe, expect, it } from "vitest";
import { parseTaskRpcRequest } from "./taskRpc";

describe("task RPC validation", () => {
  it("rejects offline queue requests and accepts shared pane operations", () => {
    expect(
      parseTaskRpcRequest({
        op: "createTask",
        projectId: "p",
        title: "work",
        deviceId: "d",
        allowOfflineDevice: true,
      }),
    ).toBeNull();
    expect(parseTaskRpcRequest({ op: "reorderPanes", taskId: "t", paneIds: ["a", "b"] })).toEqual({
      op: "reorderPanes",
      taskId: "t",
      paneIds: ["a", "b"],
    });
  });
});
