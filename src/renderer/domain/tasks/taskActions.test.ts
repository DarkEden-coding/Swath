import { describe, expect, it } from "vitest";
import {
  addSharedPane,
  completeTask,
  reconcileLocalPaneOrder,
  reactivateTask,
  shouldHideCompletedTask,
  createTaskRequest,
} from "./taskActions";

const project = {
  id: "p",
  name: "P",
  repositorySource: null,
  defaultBranch: "main",
  taskOrder: ["t"],
  revision: 1,
  createdAt: 0,
};
const task = {
  id: "t",
  projectId: "p",
  title: "T",
  assignedDeviceId: "d",
  executionGeneration: 1,
  lifecycle: "active" as const,
  paneOrder: ["a"],
  revision: 1,
  createdAt: 0,
};
const local = {
  activeProjectId: "p",
  activeTaskId: "t",
  focusedPaneId: "a",
  paneOrderByTask: { t: ["stale", "a"] },
  hiddenPaneIds: ["stale"],
  historicalTaskId: null,
};

describe("shared task actions", () => {
  it("keeps membership shared while placing a new pane locally at the end", () => {
    const result = addSharedPane({ projects: [project], tasks: [task], panes: [] }, local, {
      id: "b",
      taskId: "t",
      kind: "piAgent",
      title: null,
      sessionId: null,
      revision: 1,
    });
    expect(result.catalog.tasks[0]?.paneOrder).toEqual(["a", "b"]);
    expect(result.local.paneOrderByTask.t).toEqual(["stale", "a", "b"]);
    expect(reconcileLocalPaneOrder(result.catalog, result.local, "t").paneOrderByTask.t).toEqual([
      "a",
      "b",
    ]);
  });

  it("requires an explicitly selected online device for creation", () => {
    expect(createTaskRequest("p", "Task", null, "main", true)).toBeNull();
    expect(createTaskRequest("p", "Task", "d", "main", false)).toBeNull();
    expect(createTaskRequest("p", " Task ", "d", "main", true)).toEqual({
      projectId: "p",
      title: "Task",
      deviceId: "d",
      baseCommit: "main",
    });
  });

  it("does not hide running completed work and reactivates it without a session", () => {
    const completed = completeTask({ projects: [project], tasks: [task], panes: [] }, "t");
    expect(shouldHideCompletedTask(completed.tasks[0]!, 0, true, 3 * 24 * 60 * 60 * 1000)).toBe(
      false,
    );
    expect(reactivateTask(completed, "t").tasks[0]?.lifecycle).toBe("active");
  });
});
