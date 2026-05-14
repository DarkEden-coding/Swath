import { describe, expect, it } from "vitest";
import { closePane, collectPaneIds, createPaneLeaf, findPane, splitPaneWithId, updateSplitRatio } from "./layoutTree";
import type { LayoutNode } from "../../../shared/types";

function sample(): LayoutNode {
  return {
    type: "split",
    id: "split-1",
    direction: "vertical",
    ratio: 0.5,
    first: createPaneLeaf("terminal", "pane-1", { cwd: "/tmp", env: { A: "1" } }),
    second: createPaneLeaf("terminal", "pane-2")
  };
}

describe("layoutTree", () => {
  it("collects and finds panes", () => {
    const tree = sample();
    expect(collectPaneIds(tree)).toEqual(["pane-1", "pane-2"]);
    expect(findPane(tree, "pane-1")?.cwd).toBe("/tmp");
    expect(findPane(tree, "missing")).toBeNull();
  });

  it("splits a pane and preserves terminal config", () => {
    const split = splitPaneWithId(sample(), "pane-1", "horizontal", "pane-3");
    expect(collectPaneIds(split)).toEqual(["pane-1", "pane-3", "pane-2"]);
    expect(findPane(split, "pane-3")?.kind).toBe("terminal");
    expect(findPane(split, "pane-3")?.cwd).toBe("/tmp");
  });

  it("closes panes", () => {
    expect(collectPaneIds(closePane(sample(), "pane-1"))).toEqual(["pane-2"]);
  });

  it("clamps split ratios", () => {
    const high = updateSplitRatio(sample(), "split-1", 0.99);
    const low = updateSplitRatio(sample(), "split-1", 0.01);
    expect(high.type === "split" ? high.ratio : null).toBe(0.85);
    expect(low.type === "split" ? low.ratio : null).toBe(0.15);
  });
});
