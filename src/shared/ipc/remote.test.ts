import { describe, expect, it } from "vitest";
import { displayWorkspacePath, importRemoteValue, parseRemotePath, toRemotePath } from "./remote";

describe("remote path routing", () => {
  it("round trips machine ownership and unusual paths", () => {
    const routed = toRemotePath("dev box/1", "/Users/me/Project α");
    expect(parseRemotePath(routed)).toEqual({
      connectionId: "dev box/1",
      path: "/Users/me/Project α",
    });
    expect(displayWorkspacePath(routed)).toBe("/Users/me/Project α");
  });

  it("namespaces nested ids and absolute paths on import", () => {
    expect(importRemoteValue("machine", { id: "pane", cwd: "/repo", title: "API" })).toEqual({
      id: "machine:pane",
      cwd: toRemotePath("machine", "/repo"),
      title: "API",
    });
  });
});
