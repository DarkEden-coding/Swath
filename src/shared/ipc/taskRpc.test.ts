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
    expect(parseTaskRpcRequest({ op: "removeProject", projectId: "p" })).toEqual({
      op: "removeProject",
      projectId: "p",
    });
    expect(
      parseTaskRpcRequest({
        op: "updatePane",
        taskId: "t",
        paneId: "pane",
        sessionId: "/sessions/pi.jsonl",
        operationId: "pane-session:pane:pi",
      }),
    ).toEqual({
      op: "updatePane",
      taskId: "t",
      paneId: "pane",
      sessionId: "/sessions/pi.jsonl",
      operationId: "pane-session:pane:pi",
    });
    expect(
      parseTaskRpcRequest({ op: "updatePane", taskId: "t", paneId: "pane", sessionId: "" }),
    ).toBeNull();
  });
});
