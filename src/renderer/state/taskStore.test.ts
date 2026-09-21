import { describe, expect, it } from "vitest";
import { hydrateTaskInterfaceState } from "./taskStore";

describe("task interface state hydration", () => {
  it("preserves selection and drafts but discards obsolete pane order overrides", () => {
    const state = hydrateTaskInterfaceState({
      activeTaskId: "task",
      drafts: { pane: "unsent text" },
      paneOrderByTask: { task: ["old", "order"] },
    });
    expect(state.activeTaskId).toBe("task");
    expect(state.drafts).toEqual({ pane: "unsent text" });
    expect(state.paneOrderByTask).toEqual({});
  });
});
