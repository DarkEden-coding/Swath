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

  it("restores legacy views as tabs inside one task and preserves split layouts", () => {
    const legacy = {
      id: "workspace-1",
      name: "Project",
      path: "/project",
      activeViewId: "source",
      createdAt: 0,
      updatedAt: 0,
      views: [
        {
          id: "terminal",
          type: "workspace-view" as const,
          title: "Terminal",
          activePaneId: "old-terminal",
          layout: { type: "pane" as const, id: "old-terminal", kind: "terminal" as const },
        },
        {
          id: "source",
          type: "workspace-view" as const,
          title: "Source",
          activePaneId: "old-git",
          layout: {
            type: "split" as const,
            id: "split-1",
            direction: "vertical" as const,
            ratio: 0.5,
            first: { type: "pane" as const, id: "old-git", kind: "gitManager" as const },
            second: { type: "pane" as const, id: "old-pi", kind: "piAgent" as const },
          },
        },
      ],
    };
    const { workspace, view } = taskRendererProjection(
      { id: "legacy-task:workspace-1", title: "Task" },
      [
        { id: "legacy-pane:op:old-terminal", kind: "terminal", title: null },
        { id: "legacy-pane:op:old-git", kind: "gitManager", title: null },
        { id: "legacy-pane:op:old-pi", kind: "piAgent", title: null },
      ],
      "/project",
      null,
      legacy,
      "source",
    );

    expect(workspace.views).toHaveLength(2);
    expect(view.id).toBe("source");
    expect(view.layout).toMatchObject({
      type: "split",
      first: { id: "legacy-pane:op:old-git" },
      second: { id: "legacy-pane:op:old-pi" },
    });
  });
});
