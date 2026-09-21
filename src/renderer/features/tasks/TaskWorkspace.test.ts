import { describe, expect, it } from "vitest";
import { piSessionMetadata, reorderedPaneIds, taskRendererProjection } from "./TaskWorkspace";

describe("piSessionMetadata", () => {
  it("does not pass a migrated pane id to pi as --session", () => {
    expect(piSessionMetadata("pane_mtx8yd64_18mnuixptl0v2")).toEqual({});
    expect(piSessionMetadata("/Users/dark/.pi/agent/sessions/chat.jsonl")).toEqual({
      metadata: { piSessionFile: "/Users/dark/.pi/agent/sessions/chat.jsonl" },
    });
  });
});

describe("reorderedPaneIds", () => {
  it("moves task tabs in both directions using final indices", () => {
    expect(reorderedPaneIds(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderedPaneIds(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("leaves invalid moves unchanged", () => {
    expect(reorderedPaneIds(["a", "b"], 0, 0)).toEqual(["a", "b"]);
    expect(reorderedPaneIds(["a", "b"], -1, 1)).toEqual(["a", "b"]);
  });
});

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

  it("keeps panes as separate tabs and restores the focused tab", () => {
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
    expect(workspace.views).toHaveLength(2);
    expect(view.layout).toMatchObject({ id: "pi-1", metadata: { piSessionFile: "session-1" } });
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

  it("prunes deleted legacy panes and uses authoritative shared metadata", () => {
    const legacy = {
      id: "workspace-1",
      name: "Project",
      path: "/old",
      activeViewId: "source",
      createdAt: 0,
      updatedAt: 0,
      views: [
        {
          id: "source",
          type: "workspace-view" as const,
          title: "Source",
          activePaneId: "deleted",
          layout: {
            type: "split" as const,
            id: "split-1",
            direction: "vertical" as const,
            ratio: 0.5,
            first: { type: "pane" as const, id: "deleted", kind: "terminal" as const },
            second: {
              type: "pane" as const,
              id: "chat",
              kind: "piAgent" as const,
              metadata: { piSessionFile: "/old/session.jsonl" },
            },
          },
        },
      ],
    };
    const { view } = taskRendererProjection(
      { id: "task", title: "Task" },
      [{ id: "shared:chat", kind: "piAgent", title: "New", sessionId: "/new/session.jsonl" }],
      "/new",
      null,
      legacy,
    );
    expect(view.activePaneId).toBe("shared:chat");
    expect(view.layout).toMatchObject({
      type: "pane",
      id: "shared:chat",
      cwd: "/new",
      metadata: { piSessionFile: "/new/session.jsonl" },
    });
  });
});
