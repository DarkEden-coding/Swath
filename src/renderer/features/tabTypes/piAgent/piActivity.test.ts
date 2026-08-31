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
    usePiActivityStore.setState({ activity: {} });
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
