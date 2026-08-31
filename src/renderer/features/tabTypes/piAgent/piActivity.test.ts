import { describe, expect, it, beforeEach } from "vitest";
import {
  countPiAgents,
  reportStreaming,
  usePiActivityStore,
  type PiPaneActivity,
} from "./piActivity";

function activityOf(paneId: string): PiPaneActivity {
  return usePiActivityStore.getState().activity[paneId] ?? "idle";
}

describe("pi activity store", () => {
  beforeEach(() => {
    usePiActivityStore.setState({ activity: {}, viewedPaneIds: [] });
  });

  it("moves a pane idle -> running -> done as it streams", () => {
    reportStreaming("p1", true);
    expect(activityOf("p1")).toBe("running");
    reportStreaming("p1", false);
    expect(activityOf("p1")).toBe("done");
  });

  it("never leaves a pane stuck in done: a finished pane reports idle until it runs again", () => {
    reportStreaming("p1", false);
    expect(activityOf("p1")).toBe("idle");
  });

  it("acknowledging returns done panes to idle but keeps running ones running", () => {
    reportStreaming("done", true);
    reportStreaming("done", false);
    reportStreaming("busy", true);
    usePiActivityStore.getState().acknowledgePanes(["done", "busy", "unknown"]);
    expect(activityOf("done")).toBe("idle");
    expect(activityOf("busy")).toBe("running");
  });

  it("disposal removes the pane entirely", () => {
    reportStreaming("p1", true);
    usePiActivityStore.getState().disposePane("p1");
    expect(activityOf("p1")).toBe("idle");
  });

  it("returns to idle when a run finishes on the currently selected project", () => {
    usePiActivityStore.getState().setViewedPanes(["p1"]);
    reportStreaming("p1", true);
    reportStreaming("p1", false);
    expect(activityOf("p1")).toBe("idle");
  });

  it("still marks done when a run finishes on a project the user is not viewing", () => {
    usePiActivityStore.getState().setViewedPanes(["other"]);
    reportStreaming("p1", true);
    reportStreaming("p1", false);
    expect(activityOf("p1")).toBe("done");
  });

  it("clears finished markers when the user is already on that project", () => {
    reportStreaming("p1", true);
    reportStreaming("p1", false);
    usePiActivityStore.getState().setViewedPanes(["p1"]);
    expect(activityOf("p1")).toBe("idle");
  });

  it("counts running and finished panes", () => {
    reportStreaming("a", true);
    reportStreaming("b", true);
    reportStreaming("b", false);
    reportStreaming("c", true);
    reportStreaming("c", false);
    expect(
      countPiAgents(usePiActivityStore.getState().activity, ["a", "b", "c", "missing"]),
    ).toEqual({ running: 1, done: 2 });
  });
});
