import { describe, expect, it } from "vitest";
import { taskRendererProjection } from "./TaskWorkspace";

describe("taskRendererProjection", () => {
  it("builds registered pane leaves with the task worktree, not placeholder panes", () => {
    const { workspace, view } = taskRendererProjection(
      { id: "task-1", title: "Task" },
      [{ id: "pi-1", kind: "piAgent", title: "Pi" }],
      "/worktrees/task-1",
    );
    expect(workspace.path).toBe("/worktrees/task-1");
    expect(view.layout).toMatchObject({
      type: "pane",
      id: "pi-1",
      kind: "piAgent",
      cwd: "/worktrees/task-1",
    });
  });

  it("keeps a restored local pane order and focus without a worktree", () => {
    const { workspace, view } = taskRendererProjection(
      { id: "done", title: "Done" },
      [
        { id: "pi-2", kind: "piAgent", title: "Two", sessionId: "session-2" },
        { id: "pi-1", kind: "piAgent", title: "One", sessionId: "session-1" },
      ],
      "",
      "pi-1",
    );
    expect(workspace.path).toBe("");
    expect(view.activePaneId).toBe("pi-1");
    expect(view.layout).toMatchObject({
      type: "split",
      first: { id: "pi-2", metadata: { piSessionFile: "session-2" } },
      second: { id: "pi-1", metadata: { piSessionFile: "session-1" } },
    });
  });
});
